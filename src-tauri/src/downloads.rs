use futures_util::StreamExt;
use serde::Serialize;
use std::io::SeekFrom;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

const DOWNLOAD_CHANNELS: usize = 4;
const MULTICHANNEL_MIN_SIZE: u64 = 1024 * 1024; // 1 MB
const PROGRESS_EMIT_INTERVAL_MS: u64 = 100;
const MAX_FILENAME_BYTES: usize = 180;

fn truncate_utf8_bytes(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

pub(crate) fn sanitize_download_filename(raw: &str) -> String {
    let trimmed = raw
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches('.');
    let cleaned: String = trimmed
        .chars()
        .map(|c| match c {
            '/' | '\\' | '\0' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            _ => c,
        })
        .collect();

    if cleaned.is_empty() {
        return "download".to_string();
    }
    if cleaned.len() <= MAX_FILENAME_BYTES {
        return cleaned;
    }

    if let Some(dot_idx) = cleaned.rfind('.') {
        let ext = &cleaned[dot_idx..];
        if ext.len() > 1 && ext.len() <= 32 {
            let stem_budget = MAX_FILENAME_BYTES.saturating_sub(ext.len());
            let stem = truncate_utf8_bytes(&cleaned[..dot_idx], stem_budget).trim_end_matches('.');
            if !stem.is_empty() {
                return format!("{}{}", stem, ext);
            }
        }
    }

    let truncated = truncate_utf8_bytes(&cleaned, MAX_FILENAME_BYTES).trim_end_matches('.');
    if truncated.is_empty() {
        "download".to_string()
    } else {
        truncated.to_string()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgressPayload {
    pub file_name: String,
    pub progress: u64,
    pub downloaded: u64,
    pub total_size: u64,
    pub channels: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadCompletePayload {
    pub file_name: String,
    pub file_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadErrorPayload {
    pub file_name: String,
    pub error: String,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn emit_progress(
    app: &AppHandle,
    file_name: &str,
    downloaded: u64,
    total_size: u64,
    channels: usize,
) {
    let progress = if total_size > 0 {
        ((downloaded.min(total_size)) * 100) / total_size
    } else {
        0
    };

    #[cfg(target_os = "linux")]
    crate::gtk_panels::on_download_progress(
        app,
        file_name,
        progress,
        downloaded,
        total_size,
        channels,
    );

    let _ = app.emit(
        "download-progress",
        DownloadProgressPayload {
            file_name: file_name.to_string(),
            progress,
            downloaded,
            total_size,
            channels,
        },
    );
}

fn emit_error(app: &AppHandle, file_name: &str, error: &str) {
    #[cfg(target_os = "linux")]
    crate::gtk_panels::on_download_error(app, file_name, error);

    let _ = app.emit(
        "download-error",
        DownloadErrorPayload {
            file_name: file_name.to_string(),
            error: error.to_string(),
        },
    );
}

fn emit_complete(app: &AppHandle, file_name: &str, dest_path: &Path) {
    let path_str = dest_path.to_string_lossy().to_string();

    #[cfg(target_os = "linux")]
    crate::gtk_panels::on_download_complete(app, file_name, &path_str);

    let _ = app.emit(
        "download-complete",
        DownloadCompletePayload {
            file_name: file_name.to_string(),
            file_path: path_str,
        },
    );
}

enum ProbeOutcome {
    MultiChannel {
        resolved_url: String,
        total_size: u64,
    },
    SingleResponse(reqwest::Response),
    FallbackSingle,
}

/// Probes range support with a single `GET Range: bytes=0-0` request.
/// - `206 Partial Content` with `Content-Range` >= `MULTICHANNEL_MIN_SIZE` -> `MultiChannel`
/// - `200 OK` (server ignored `Range`) -> reuses the same `Response` for single-channel streaming
/// - Any other status / error -> `FallbackSingle` (plain `GET` without `Range`)
async fn probe_download(client: &reqwest::Client, url: &str) -> ProbeOutcome {
    let Ok(resp) = client
        .get(url)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .send()
        .await
    else {
        return ProbeOutcome::FallbackSingle;
    };

    if resp.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        let total_size = resp
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|cr| cr.rsplit('/').next())
            .and_then(|s| s.trim().parse::<u64>().ok());

        if let Some(size) = total_size {
            if size >= MULTICHANNEL_MIN_SIZE {
                return ProbeOutcome::MultiChannel {
                    resolved_url: resp.url().to_string(),
                    total_size: size,
                };
            }
        }
        return ProbeOutcome::FallbackSingle;
    }

    if resp.status().is_success() {
        return ProbeOutcome::SingleResponse(resp);
    }

    ProbeOutcome::FallbackSingle
}

async fn download_multi_channel(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    dest_path: &Path,
    final_name: &str,
    total_size: u64,
) -> Result<(), String> {
    let file = tokio::fs::File::create(dest_path)
        .await
        .map_err(|e| e.to_string())?;
    file.set_len(total_size).await.map_err(|e| e.to_string())?;
    drop(file);

    emit_progress(app, final_name, 0, total_size, DOWNLOAD_CHANNELS);

    let downloaded_counter = Arc::new(AtomicU64::new(0));
    let last_emit_ms = Arc::new(AtomicU64::new(now_millis()));
    let chunk_size = total_size / DOWNLOAD_CHANNELS as u64;

    let mut handles = Vec::with_capacity(DOWNLOAD_CHANNELS);

    for i in 0..DOWNLOAD_CHANNELS {
        let start = i as u64 * chunk_size;
        let end = if i == DOWNLOAD_CHANNELS - 1 {
            total_size - 1
        } else {
            (i as u64 + 1) * chunk_size - 1
        };

        let client = client.clone();
        let url = url.to_string();
        let path = dest_path.to_path_buf();
        let app = app.clone();
        let file_name = final_name.to_string();
        let downloaded_counter = Arc::clone(&downloaded_counter);
        let last_emit_ms = Arc::clone(&last_emit_ms);

        let handle = tokio::spawn(async move {
            let response = client
                .get(&url)
                .header(reqwest::header::RANGE, format!("bytes={start}-{end}"))
                .send()
                .await
                .map_err(|e| e.to_string())?;

            if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
                return Err(format!(
                    "Expected 206 Partial Content for range {start}-{end}, got {}",
                    response.status()
                ));
            }

            let mut part_file = tokio::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .await
                .map_err(|e| e.to_string())?;
            part_file
                .seek(SeekFrom::Start(start))
                .await
                .map_err(|e| e.to_string())?;

            let mut stream = response.bytes_stream();
            while let Some(chunk_res) = stream.next().await {
                let chunk = chunk_res.map_err(|e| e.to_string())?;
                part_file
                    .write_all(&chunk)
                    .await
                    .map_err(|e| e.to_string())?;

                let total_downloaded =
                    downloaded_counter.fetch_add(chunk.len() as u64, Ordering::Relaxed)
                        + chunk.len() as u64;

                let now = now_millis();
                let prev = last_emit_ms.load(Ordering::Relaxed);
                if now.saturating_sub(prev) >= PROGRESS_EMIT_INTERVAL_MS
                    && last_emit_ms
                        .compare_exchange(prev, now, Ordering::Relaxed, Ordering::Relaxed)
                        .is_ok()
                {
                    emit_progress(
                        &app,
                        &file_name,
                        total_downloaded,
                        total_size,
                        DOWNLOAD_CHANNELS,
                    );
                }
            }

            part_file.flush().await.map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        });

        handles.push(handle);
    }

    let mut handle_iter = handles.into_iter();
    while let Some(handle) = handle_iter.next() {
        let failed = match handle.await {
            Ok(Ok(())) => None,
            Ok(Err(err)) => Some(err),
            Err(join_err) => Some(join_err.to_string()),
        };

        if let Some(err) = failed {
            for remaining in handle_iter {
                remaining.abort();
            }
            let _ = tokio::fs::remove_file(dest_path).await;
            return Err(err);
        }
    }

    emit_progress(app, final_name, total_size, total_size, DOWNLOAD_CHANNELS);
    Ok(())
}

async fn stream_single_response(
    app: &AppHandle,
    response: reqwest::Response,
    dest_path: &Path,
    final_name: &str,
) -> Result<(), String> {
    if !response.status().is_success() {
        let msg = format!("HTTP error: {}", response.status());
        emit_error(app, final_name, &msg);
        return Err(msg);
    }

    let total_size = response.content_length().unwrap_or(0);
    let mut file = match tokio::fs::File::create(dest_path).await {
        Ok(f) => f,
        Err(err) => {
            let msg = err.to_string();
            emit_error(app, final_name, &msg);
            return Err(msg);
        }
    };

    emit_progress(app, final_name, 0, total_size, 1);

    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit = now_millis();

    while let Some(chunk_res) = stream.next().await {
        match chunk_res {
            Ok(chunk) => {
                if let Err(err) = file.write_all(&chunk).await {
                    let _ = tokio::fs::remove_file(dest_path).await;
                    let msg = err.to_string();
                    emit_error(app, final_name, &msg);
                    return Err(msg);
                }
                downloaded += chunk.len() as u64;
                let now = now_millis();
                if now.saturating_sub(last_emit) >= PROGRESS_EMIT_INTERVAL_MS {
                    last_emit = now;
                    emit_progress(app, final_name, downloaded, total_size, 1);
                }
            }
            Err(err) => {
                let _ = tokio::fs::remove_file(dest_path).await;
                let msg = err.to_string();
                emit_error(app, final_name, &msg);
                return Err(msg);
            }
        }
    }

    let _ = file.flush().await;
    emit_progress(app, final_name, downloaded, total_size, 1);
    Ok(())
}

async fn download_single_channel(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    dest_path: &Path,
    final_name: &str,
) -> Result<(), String> {
    let response = match client.get(url).send().await {
        Ok(resp) => resp,
        Err(err) => {
            let msg = err.to_string();
            emit_error(app, final_name, &msg);
            return Err(msg);
        }
    };

    stream_single_response(app, response, dest_path, final_name).await
}

#[tauri::command]
pub async fn download_item(app: AppHandle, url: String, file_name: String) -> Result<(), String> {
    let default_name = sanitize_download_filename(&file_name);

    let picked = rfd::AsyncFileDialog::new()
        .set_file_name(&default_name)
        .save_file()
        .await;

    let Some(file_handle) = picked else {
        return Ok(());
    };

    let mut dest_path = file_handle.path().to_path_buf();
    if let Some(name) = dest_path.file_name().and_then(|s| s.to_str()) {
        if name.len() > 240 {
            dest_path.set_file_name(sanitize_download_filename(name));
        }
    }
    let final_name = dest_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(default_name);

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    match probe_download(&client, &url).await {
        ProbeOutcome::MultiChannel {
            resolved_url,
            total_size,
        } => {
            if download_multi_channel(
                &app,
                &client,
                &resolved_url,
                &dest_path,
                &final_name,
                total_size,
            )
            .await
            .is_err()
            {
                download_single_channel(&app, &client, &url, &dest_path, &final_name).await?;
            }
        }
        ProbeOutcome::SingleResponse(resp) => {
            stream_single_response(&app, resp, &dest_path, &final_name).await?;
        }
        ProbeOutcome::FallbackSingle => {
            download_single_channel(&app, &client, &url, &dest_path, &final_name).await?;
        }
    }

    emit_complete(&app, &final_name, &dest_path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_long_filename_preserving_extension() {
        let long_stem = "a".repeat(300);
        let name = format!("{}.mp4", long_stem);
        let sanitized = sanitize_download_filename(&name);
        assert!(sanitized.len() <= MAX_FILENAME_BYTES);
        assert!(sanitized.ends_with(".mp4"));
    }

    #[test]
    fn sanitizes_invalid_chars_and_empty_names() {
        assert_eq!(sanitize_download_filename(""), "download");
        assert_eq!(sanitize_download_filename("foo/bar:baz?q=1"), "foo_bar_baz");
    }
}
