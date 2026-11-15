mod adblocker;
mod downloads;
mod extensions;
#[cfg(target_os = "linux")]
mod gtk_panels;
#[cfg(target_os = "linux")]
mod gtk_ui;
mod tabs;

use adblocker::{
    add_custom_filter, add_to_whitelist, get_adblock_stats, get_adblock_status, init_adblocker,
    record_ad_blocked, reset_adblock_stats, toggle_adblock, update_filter_lists,
};
use downloads::download_item;
use extensions::{
    build_chrome_api_shim, install_cws_extension, list_extensions, load_unpacked_extension,
    reload_extension, remove_extension, toggle_extension, ExtensionManager, ExtensionManagerState,
};
use tabs::{
    apply_layout, close_overlay_panel, close_tab_webview, create_tab_webview, eval_tab_js,
    navigate_tab, notify_context_menu, open_overlay_panel, print_tab, reload_tab,
    resize_tab_webview, reveal_overlay, set_overlay_visible, switch_tab_webview,
    toggle_devtools_tab, TabManagerState,
};
#[cfg(not(target_os = "linux"))]
use tauri::{webview::WebviewBuilder, LogicalPosition, LogicalSize, WebviewUrl};
use tauri::{window::WindowBuilder, AppHandle, Manager, WindowEvent};

#[tauri::command]
fn window_minimize(app: AppHandle) {
    if let Some(win) = app.get_window("main") {
        let is_min = win.is_minimized().unwrap_or(false);
        if is_min {
            let _ = win.unminimize();
        } else {
            let _ = win.minimize();
        }
    }
}

#[tauri::command]
fn window_maximize(app: AppHandle) {
    if let Some(win) = app.get_window("main") {
        let is_max = win.is_maximized().unwrap_or(false);
        if is_max {
            let _ = win.unmaximize();
        } else {
            let _ = win.maximize();
        }
    }
}

#[tauri::command]
fn window_close(app: AppHandle) {
    if let Some(win) = app.get_window("main") {
        let _ = win.close();
    }
}

#[tauri::command]
fn close_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn copy_to_clipboard(text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(text).map_err(|e| e.to_string())
}

fn normalize_cli_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed == "newtab.html" || trimmed.ends_with("/newtab.html") {
        return Some("newtab.html".to_string());
    }
    if let Ok(parsed) = url::Url::parse(trimmed) {
        let scheme = parsed.scheme();
        if trimmed.contains("://")
            || matches!(
                scheme,
                "http"
                    | "https"
                    | "file"
                    | "about"
                    | "data"
                    | "chrome-extension"
                    | "tauri"
                    | "view-source"
                    | "mailto"
                    | "ftp"
            )
        {
            return Some(trimmed.to_string());
        }
    }
    let path = std::path::Path::new(trimmed);
    if path.exists() {
        let abs = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(path))
                .unwrap_or_else(|_| path.to_path_buf())
        };
        let canonical = std::fs::canonicalize(&abs).unwrap_or(abs);
        if let Ok(file_url) = url::Url::from_file_path(canonical) {
            return Some(file_url.to_string());
        }
    }
    let with_https = format!("https://{trimmed}");
    if url::Url::parse(&with_https).is_ok() {
        return Some(with_https);
    }
    None
}

pub fn collect_startup_urls() -> Vec<String> {
    let mut urls: Vec<String> = std::env::var("FORKIT_BENCH_URLS")
        .unwrap_or_default()
        .split(',')
        .filter_map(normalize_cli_url)
        .collect();

    let mut after_double_dash = false;
    for arg in std::env::args().skip(1) {
        if !after_double_dash && arg == "--" {
            after_double_dash = true;
            continue;
        }
        if !after_double_dash && arg.starts_with('-') {
            continue;
        }
        if let Some(u) = normalize_cli_url(&arg) {
            urls.push(u);
        }
    }
    urls
}

#[cfg(target_os = "linux")]
fn ipc_socket_path() -> std::path::PathBuf {
    if let Some(runtime_dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        if !runtime_dir.is_empty() {
            return std::path::PathBuf::from(runtime_dir).join("forkit-ipc.sock");
        }
    }
    let user = std::env::var("USER").unwrap_or_else(|_| "user".to_string());
    std::env::temp_dir().join(format!("forkit-ipc-{user}.sock"))
}

#[cfg(target_os = "linux")]
fn should_bypass_single_instance() -> bool {
    std::env::var_os("FORKIT_BENCH_URLS").is_some()
        || std::env::args().any(|a| a == "--new-instance")
}

#[cfg(target_os = "linux")]
fn try_forward_to_running_instance(urls: &[String]) -> bool {
    use std::io::Write;
    if should_bypass_single_instance() {
        return false;
    }
    let sock_path = ipc_socket_path();
    let Ok(mut stream) = std::os::unix::net::UnixStream::connect(&sock_path) else {
        return false;
    };
    let Ok(payload) = serde_json::to_string(urls) else {
        return false;
    };
    stream.write_all(payload.as_bytes()).is_ok()
        && stream.write_all(b"\n").is_ok()
        && stream.flush().is_ok()
}

#[cfg(target_os = "linux")]
fn start_ipc_listener(app: AppHandle) {
    use std::io::{BufRead, BufReader};
    if should_bypass_single_instance() {
        return;
    }
    let sock_path = ipc_socket_path();
    let _ = std::fs::remove_file(&sock_path);
    let Ok(listener) = std::os::unix::net::UnixListener::bind(&sock_path) else {
        return;
    };
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() {
                continue;
            }
            let urls: Vec<String> = serde_json::from_str(line.trim()).unwrap_or_default();
            let app_clone = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(win) = app_clone.get_window("main") {
                    let _ = win.unminimize();
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                for u in urls {
                    gtk_ui::create_native_tab(&app_clone, &u);
                }
            });
        }
    });
}

#[tauri::command]
fn get_startup_urls() -> Vec<String> {
    collect_startup_urls()
}

#[cfg(target_os = "linux")]
fn init_linux_memory_tuning() {
    use webkit2gtk::{MemoryPressureSettings, WebsiteDataManager};

    let mut mp = MemoryPressureSettings::new();
    mp.set_memory_limit(320);
    mp.set_conservative_threshold(0.40);
    mp.set_strict_threshold(0.65);
    mp.set_kill_threshold(0.0);
    mp.set_poll_interval(4.0);
    WebsiteDataManager::set_memory_pressure_settings(&mut mp);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    {
        let startup_urls = collect_startup_urls();
        if try_forward_to_running_instance(&startup_urls) {
            return;
        }
    }

    let builder = tauri::Builder::default().manage(TabManagerState::default());
    #[cfg(target_os = "linux")]
    let builder = builder
        .manage(gtk_ui::NativeUiState::default())
        .manage(gtk_panels::NativePanelsState::default());

    builder
        .setup(|app| {
            #[cfg(target_os = "linux")]
            init_linux_memory_tuning();

            let app_data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("forkit-data"));
            let ad_dir = app_data_dir.clone();
            let ext_dir = app_data_dir;

            let ad_handle = std::thread::spawn(move || adblocker::AdBlocker::new(ad_dir));
            let ext_handle = std::thread::spawn(move || ExtensionManager::load(ext_dir));

            let mut win_builder = WindowBuilder::new(app, "main")
                .title("Forkit Browser")
                .inner_size(1400.0, 800.0)
                .decorations(false);
            if let Some(icon) = app.default_window_icon() {
                win_builder = win_builder.icon(icon.clone())?;
            }
            let main_window = win_builder.build()?;

            let ad_blocker = ad_handle
                .join()
                .unwrap_or_else(|_| adblocker::AdBlocker::new(std::env::temp_dir().join("forkit-data")));
            app.manage(adblocker::AdBlockerState {
                inner: std::sync::Mutex::new(ad_blocker),
            });

            let ext_mgr = ext_handle
                .join()
                .unwrap_or_else(|_| ExtensionManager::load(std::env::temp_dir().join("forkit-extensions")));
            app.manage(ExtensionManagerState {
                inner: std::sync::Mutex::new(ext_mgr),
            });

            #[cfg(target_os = "linux")]
            {
                gtk_panels::init_panels(app.handle());
                gtk_ui::init_native_top_bar(app.handle());
                start_ipc_listener(app.handle().clone());
            }

            #[cfg(not(target_os = "linux"))]
            let _ui_webview = main_window.add_child(
                WebviewBuilder::new("ui", WebviewUrl::App("index.html".into())),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(1400.0, 104.0),
            )?;

            let app_handle = app.handle().clone();
            main_window.on_window_event(move |event| {
                if let WindowEvent::Resized(phys_size) = event {
                    if let Some(win) = app_handle.get_window("main") {
                        let scale = win.scale_factor().unwrap_or(1.0);
                        let logical = phys_size.to_logical::<f64>(scale);
                        if let Some(tab_state) = app_handle.try_state::<TabManagerState>() {
                            *tab_state.window_size.lock().unwrap() =
                                (logical.width, logical.height);
                            apply_layout(&app_handle, &tab_state);
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window_minimize,
            window_maximize,
            window_close,
            close_app,
            copy_to_clipboard,
            get_startup_urls,
            create_tab_webview,
            switch_tab_webview,
            close_tab_webview,
            resize_tab_webview,
            set_overlay_visible,
            open_overlay_panel,
            reveal_overlay,
            close_overlay_panel,
            navigate_tab,
            reload_tab,
            eval_tab_js,
            print_tab,
            toggle_devtools_tab,
            notify_context_menu,
            download_item,
            get_adblock_stats,
            toggle_adblock,
            update_filter_lists,
            add_custom_filter,
            add_to_whitelist,
            reset_adblock_stats,
            get_adblock_status,
            record_ad_blocked,
            list_extensions,
            load_unpacked_extension,
            toggle_extension,
            remove_extension,
            reload_extension,
            install_cws_extension,
        ])
        .register_uri_scheme_protocol("chrome-extension", |ctx, request| {
            let app = ctx.app_handle();
            let uri = request.uri();
            let ext_id = uri.host().unwrap_or("");
            let path = uri.path().trim_start_matches('/');

            let json_resp = |status: u16, body: Vec<u8>, mime: &str| {
                tauri::http::Response::builder()
                    .status(status)
                    .header("Content-Type", mime)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(body)
                    .unwrap()
            };

            if path == "__forkit_storage" {
                let body_val: serde_json::Value = serde_json::from_slice(request.body())
                    .unwrap_or(serde_json::Value::Null);
                let action = body_val.get("action").and_then(|v| v.as_str()).unwrap_or("get");
                let payload = body_val.get("payload").cloned().unwrap_or(serde_json::Value::Null);
                let res = if let Some(st) = app.try_state::<ExtensionManagerState>() {
                    st.inner.lock().unwrap().storage_op(ext_id, action, payload)
                } else {
                    serde_json::json!({})
                };
                return json_resp(
                    200,
                    serde_json::to_vec(&res).unwrap_or_else(|_| b"{}".to_vec()),
                    "application/json; charset=utf-8",
                );
            }

            if path == "__forkit_active_tab" {
                let (id, url, title) = {
                    #[cfg(target_os = "linux")]
                    {
                        gtk_ui::get_active_tab_info(app)
                    }
                    #[cfg(not(target_os = "linux"))]
                    {
                        (1u64, String::new(), String::new())
                    }
                };
                let res = serde_json::json!({ "id": id, "url": url, "title": title, "active": true });
                return json_resp(
                    200,
                    serde_json::to_vec(&res).unwrap_or_else(|_| b"{}".to_vec()),
                    "application/json; charset=utf-8",
                );
            }

            if path == "__forkit_open_tab" {
                let body_val: serde_json::Value = serde_json::from_slice(request.body())
                    .unwrap_or(serde_json::Value::Null);
                if let Some(target_url) = body_val.get("url").and_then(|v| v.as_str()) {
                    #[cfg(target_os = "linux")]
                    {
                        gtk_ui::open_new_tab_from_extension(app, target_url);
                    }
                    #[cfg(not(target_os = "linux"))]
                    {
                        let _ = target_url;
                    }
                }
                return json_resp(200, b"{}".to_vec(), "application/json; charset=utf-8");
            }

            if path == "__forkit_reload_tab" {
                if let Some(ts) = app.try_state::<TabManagerState>() {
                    if let Some(active_id) = *ts.active_tab_id.lock().unwrap() {
                        let _ = reload_tab(app.clone(), active_id);
                    }
                }
                return json_resp(200, b"{}".to_vec(), "application/json; charset=utf-8");
            }

            if let Some(st) = app.try_state::<ExtensionManagerState>() {
                let mgr = st.inner.lock().unwrap();
                if let Some((bytes, mime)) = mgr.resolve_asset(ext_id, path) {
                    if mime.starts_with("text/html") {
                        if let Some(ext) = mgr.extensions.iter().find(|e| e.id == ext_id) {
                            let active_tab = {
                                #[cfg(target_os = "linux")]
                                {
                                    gtk_ui::get_active_tab_info(app)
                                }
                                #[cfg(not(target_os = "linux"))]
                                {
                                    (1u64, String::new(), String::new())
                                }
                            };
                            let shim = format!(
                                "<script>{}</script>",
                                build_chrome_api_shim(
                                    ext,
                                    true,
                                    Some((active_tab.0, &active_tab.1, &active_tab.2))
                                )
                            );
                            let html = String::from_utf8_lossy(&bytes);
                            let injected = if let Some(pos) = html.to_ascii_lowercase().find("<head>") {
                                let mut out = String::with_capacity(html.len() + shim.len());
                                out.push_str(&html[..pos + 6]);
                                out.push_str(&shim);
                                out.push_str(&html[pos + 6..]);
                                out
                            } else {
                                format!("{shim}{html}")
                            };
                            return json_resp(200, injected.into_bytes(), mime);
                        }
                    }
                    return json_resp(200, bytes, mime);
                }
            }

            json_resp(404, b"Not Found".to_vec(), "text/plain; charset=utf-8")
        })
        .run(tauri::generate_context!())
        .expect("error while running Forkit Browser");
}

#[cfg(test)]
mod tests {
    use super::normalize_cli_url;

    #[test]
    fn normalizes_cli_urls() {
        assert_eq!(normalize_cli_url(""), None);
        assert_eq!(normalize_cli_url("   "), None);
        assert_eq!(
            normalize_cli_url("newtab.html"),
            Some("newtab.html".to_string())
        );
        assert_eq!(
            normalize_cli_url("https://example.com/path?a=1"),
            Some("https://example.com/path?a=1".to_string())
        );
        assert_eq!(
            normalize_cli_url("http://localhost:3000"),
            Some("http://localhost:3000".to_string())
        );
        assert_eq!(
            normalize_cli_url("example.com"),
            Some("https://example.com".to_string())
        );
        assert_eq!(
            normalize_cli_url("localhost:3000"),
            Some("https://localhost:3000".to_string())
        );
    }
}
