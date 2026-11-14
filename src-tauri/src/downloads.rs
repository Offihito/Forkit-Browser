use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgressPayload {
    pub file_name: String,
    pub progress: u64,
    pub downloaded: u64,
    pub total_size: u64,
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

#[tauri::command]
pub async fn download_item(app: AppHandle, url: String, file_name: String) -> Result<(), String> {
    let default_name = if file_name.is_empty() {
        "download".to_string()
    } else {
        file_name
    };

    let picked = rfd::AsyncFileDialog::new()
        .set_file_name(&default_name)
        .save_file()
        .await;

    let Some(file_handle) = picked else {
        return Ok(());
    };

    let dest_path = file_handle.path().to_path_buf();
    let final_name = dest_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(default_name);

    let client = reqwest::Client::new();
    let response = match client.get(&url).send().await {
        Ok(resp) => resp,
        Err(err) => {
            #[cfg(target_os = "linux")]
            crate::gtk_panels::on_download_error(&app, &final_name, &err.to_string());
            let _ = app.emit(
                "download-error",
                DownloadErrorPayload {
                    file_name: final_name,
                    error: err.to_string(),
                },
            );
            return Err(err.to_string());
        }
    };

    let total_size = response.content_length().unwrap_or(0);
    let mut file = match tokio::fs::File::create(&dest_path).await {
        Ok(f) => f,
        Err(err) => {
            #[cfg(target_os = "linux")]
            crate::gtk_panels::on_download_error(&app, &final_name, &err.to_string());
            let _ = app.emit(
                "download-error",
                DownloadErrorPayload {
                    file_name: final_name,
                    error: err.to_string(),
                },
            );
            return Err(err.to_string());
        }
    };

    #[cfg(target_os = "linux")]
    crate::gtk_panels::on_download_progress(&app, &final_name, 0, 0, total_size);

    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;

    while let Some(chunk_res) = stream.next().await {
        match chunk_res {
            Ok(chunk) => {
                if let Err(err) = file.write_all(&chunk).await {
                    let _ = tokio::fs::remove_file(&dest_path).await;
                    #[cfg(target_os = "linux")]
                    crate::gtk_panels::on_download_error(&app, &final_name, &err.to_string());
                    let _ = app.emit(
                        "download-error",
                        DownloadErrorPayload {
                            file_name: final_name,
                            error: err.to_string(),
                        },
                    );
                    return Err(err.to_string());
                }
                downloaded += chunk.len() as u64;
                let progress = if total_size > 0 {
                    (downloaded * 100) / total_size
                } else {
                    0
                };
                #[cfg(target_os = "linux")]
                crate::gtk_panels::on_download_progress(
                    &app,
                    &final_name,
                    progress,
                    downloaded,
                    total_size,
                );
                let _ = app.emit(
                    "download-progress",
                    DownloadProgressPayload {
                        file_name: final_name.clone(),
                        progress,
                        downloaded,
                        total_size,
                    },
                );
            }
            Err(err) => {
                let _ = tokio::fs::remove_file(&dest_path).await;
                #[cfg(target_os = "linux")]
                crate::gtk_panels::on_download_error(&app, &final_name, &err.to_string());
                let _ = app.emit(
                    "download-error",
                    DownloadErrorPayload {
                        file_name: final_name,
                        error: err.to_string(),
                    },
                );
                return Err(err.to_string());
            }
        }
    }

    let _ = file.flush().await;
    #[cfg(target_os = "linux")]
    crate::gtk_panels::on_download_complete(&app, &final_name, &dest_path.to_string_lossy());
    let _ = app.emit(
        "download-complete",
        DownloadCompletePayload {
            file_name: final_name,
            file_path: dest_path.to_string_lossy().to_string(),
        },
    );

    Ok(())
}
