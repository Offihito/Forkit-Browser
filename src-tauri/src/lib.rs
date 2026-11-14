mod adblocker;
mod downloads;
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

#[tauri::command]
fn get_startup_urls() -> Vec<String> {
    std::env::var("FORKIT_BENCH_URLS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
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
    let builder = tauri::Builder::default().manage(TabManagerState::default());
    #[cfg(target_os = "linux")]
    let builder = builder
        .manage(gtk_ui::NativeUiState::default())
        .manage(gtk_panels::NativePanelsState::default());

    builder
        .setup(|app| {
            #[cfg(target_os = "linux")]
            init_linux_memory_tuning();

            let ad_state = init_adblocker(app.handle());
            app.manage(ad_state);

            let main_window = WindowBuilder::new(app, "main")
                .title("Forkit Browser")
                .inner_size(1400.0, 800.0)
                .decorations(false)
                .build()?;

            #[cfg(target_os = "linux")]
            {
                gtk_panels::init_panels(app.handle());
                gtk_ui::init_native_top_bar(app.handle());
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Forkit Browser");
}
