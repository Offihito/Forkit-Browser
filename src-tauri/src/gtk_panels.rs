use gtk::prelude::*;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::adblocker::AdBlockerState;
use crate::gtk_ui::NativeUiState;
use crate::tabs::{navigate_tab, reload_tab};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub url: String,
    pub title: String,
    pub timestamp: u64,
}

#[derive(Clone, Debug)]
pub struct DownloadEntry {
    pub file_name: String,
    pub progress: u64,
    pub downloaded: u64,
    pub total_size: u64,
    pub status: String,
    pub path: String,
    pub channels: usize,
}

pub struct NativePanelsState {
    pub history: Mutex<Vec<HistoryEntry>>,
    pub downloads: Mutex<Vec<DownloadEntry>>,
    pub history_file: Mutex<Option<PathBuf>>,
    pub last_dl_refresh: Mutex<Option<std::time::Instant>>,
}

impl Default for NativePanelsState {
    fn default() -> Self {
        Self {
            history: Mutex::new(Vec::new()),
            downloads: Mutex::new(Vec::new()),
            history_file: Mutex::new(None),
            last_dl_refresh: Mutex::new(None),
        }
    }
}

pub fn init_panels(app: &AppHandle) {
    let Some(st) = app.try_state::<NativePanelsState>() else {
        return;
    };
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("history.json");
        if let Ok(raw) = std::fs::read_to_string(&file) {
            if let Ok(entries) = serde_json::from_str::<Vec<HistoryEntry>>(&raw) {
                *st.history.lock().unwrap() = entries;
            }
        }
        *st.history_file.lock().unwrap() = Some(file);
    }
}

fn persist_history(st: &NativePanelsState) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SAVE_GEN: AtomicU64 = AtomicU64::new(0);

    let file_opt = st.history_file.lock().unwrap().clone();
    if let Some(path) = file_opt {
        let data = st.history.lock().unwrap().clone();
        let gen = SAVE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(250));
            if SAVE_GEN.load(Ordering::SeqCst) != gen {
                return;
            }
            if let Ok(json) = serde_json::to_string(&data) {
                let _ = std::fs::write(path, json);
            }
        });
    }
}

pub fn record_history(app: &AppHandle, url: &str, title: &str) {
    if url.is_empty() || url.contains("newtab.html") {
        return;
    }
    let Some(st) = app.try_state::<NativePanelsState>() else {
        return;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    {
        let mut hist = st.history.lock().unwrap();
        if let Some(last) = hist.last_mut() {
            if last.url == url {
                if !title.trim().is_empty() && title != "Loading..." {
                    last.title = title.to_string();
                }
                last.timestamp = now;
                drop(hist);
                persist_history(&st);
                return;
            }
        }
        hist.push(HistoryEntry {
            url: url.to_string(),
            title: if title.trim().is_empty() {
                url.to_string()
            } else {
                title.to_string()
            },
            timestamp: now,
        });
        if hist.len() > 500 {
            let drain_count = hist.len() - 500;
            hist.drain(0..drain_count);
        }
    }
    persist_history(&st);
}

pub fn update_history_title(app: &AppHandle, url: &str, title: &str) {
    if url.is_empty() || url.contains("newtab.html") || title.trim().is_empty() {
        return;
    }
    let Some(st) = app.try_state::<NativePanelsState>() else {
        return;
    };
    let mut changed = false;
    {
        let mut hist = st.history.lock().unwrap();
        if let Some(entry) = hist.iter_mut().rev().find(|e| e.url == url) {
            entry.title = title.to_string();
            changed = true;
        }
    }
    if changed {
        persist_history(&st);
    }
}

fn schedule_downloads_refresh(app: &AppHandle, force: bool) {
    if !force {
        if let Some(st) = app.try_state::<NativePanelsState>() {
            let mut last = st.last_dl_refresh.lock().unwrap();
            let now = std::time::Instant::now();
            if let Some(prev) = *last {
                if now.duration_since(prev).as_millis() < 100 {
                    return;
                }
            }
            *last = Some(now);
        }
    }
    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        let list_opt = ACTIVE_DOWNLOADS_LIST.with(|cell| cell.borrow().clone());
        if let Some(list) = list_opt {
            populate_downloads_list(&app_clone, &list);
        }
    });
}

pub fn on_download_progress(
    app: &AppHandle,
    file_name: &str,
    progress: u64,
    downloaded: u64,
    total_size: u64,
    channels: usize,
) {
    let Some(st) = app.try_state::<NativePanelsState>() else {
        return;
    };
    {
        let mut dls = st.downloads.lock().unwrap();
        if let Some(item) = dls
            .iter_mut()
            .rev()
            .find(|d| d.file_name == file_name && d.status == "Downloading")
        {
            item.progress = progress;
            item.downloaded = downloaded;
            item.total_size = total_size;
            item.channels = channels;
        } else {
            dls.push(DownloadEntry {
                file_name: file_name.to_string(),
                progress,
                downloaded,
                total_size,
                status: "Downloading".to_string(),
                path: String::new(),
                channels,
            });
        }
    }
    schedule_downloads_refresh(app, progress == 0 || progress >= 100);
}

pub fn on_download_complete(app: &AppHandle, file_name: &str, file_path: &str) {
    let Some(st) = app.try_state::<NativePanelsState>() else {
        return;
    };
    {
        let mut dls = st.downloads.lock().unwrap();
        if let Some(item) = dls.iter_mut().rev().find(|d| d.file_name == file_name) {
            item.progress = 100;
            if item.total_size > 0 {
                item.downloaded = item.total_size;
            }
            item.status = "Completed".to_string();
            item.path = file_path.to_string();
        } else {
            dls.push(DownloadEntry {
                file_name: file_name.to_string(),
                progress: 100,
                downloaded: 0,
                total_size: 0,
                status: "Completed".to_string(),
                path: file_path.to_string(),
                channels: 1,
            });
        }
    }
    schedule_downloads_refresh(app, true);
}

pub fn on_download_error(app: &AppHandle, file_name: &str, error: &str) {
    let Some(st) = app.try_state::<NativePanelsState>() else {
        return;
    };
    {
        let mut dls = st.downloads.lock().unwrap();
        if let Some(item) = dls.iter_mut().rev().find(|d| d.file_name == file_name) {
            item.status = format!("Failed: {}", error);
        } else {
            dls.push(DownloadEntry {
                file_name: file_name.to_string(),
                progress: 0,
                downloaded: 0,
                total_size: 0,
                status: format!("Failed: {}", error),
                path: String::new(),
                channels: 1,
            });
        }
    }
    schedule_downloads_refresh(app, true);
}

fn ensure_panel_css(app: &AppHandle) {
    thread_local! {
        static PANEL_CSS_INIT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }
    PANEL_CSS_INIT.with(|init| {
        if init.get() {
            return;
        }
        init.set(true);
        let dark = crate::gtk_ui::is_system_dark(app.get_window("main").as_ref());
        let css = gtk::CssProvider::new();
        let css_bytes: &[u8] = if dark {
            b"
            .forkit-panel-backdrop {
                background-color: rgba(0, 0, 0, 0.65);
            }
            .forkit-panel-box {
                background-color: #16161b;
                color: #f0eff4;
                border: 1px solid #272730;
                border-radius: 10px;
                padding: 18px;
            }
            .forkit-panel-popover {
                background-color: #16161b;
                color: #f0eff4;
                border: 1px solid #272730;
                border-radius: 10px;
                padding: 16px;
            }
            .forkit-panel-full {
                background-color: #101014;
                color: #f0eff4;
                border: none;
                border-radius: 0;
                padding: 24px 36px;
            }
            .forkit-panel-title {
                font-size: 16px;
                font-weight: bold;
                color: #f0eff4;
            }
            .forkit-panel-title-lg {
                font-size: 20px;
                font-weight: bold;
                color: #f0eff4;
            }
            .forkit-panel-muted {
                font-size: 12px;
                color: #8e8d9a;
            }
            .forkit-panel-sub {
                font-size: 11px;
                color: #6b6a78;
            }
            .forkit-panel-item-title {
                font-size: 13px;
                font-weight: 600;
                color: #f0eff4;
            }
            .forkit-panel-card {
                background-color: #1e1e25;
                border: 1px solid #272730;
                border-radius: 8px;
                padding: 12px;
            }
            .forkit-panel-dl-card {
                background-color: #1e1e25;
                border: 1px solid #272730;
                border-radius: 8px;
                padding: 10px 12px;
            }
            .forkit-panel-icon-badge {
                background-color: #231f33;
                color: #a78bfa;
                border-radius: 8px;
                padding: 7px;
            }
            .forkit-panel-search {
                background-color: #101014;
                color: #f0eff4;
                border: 1px solid #272730;
                border-radius: 8px;
                padding: 6px 14px;
                min-height: 22px;
            }
            .forkit-panel-search:focus {
                border-color: #a78bfa;
            }
            .forkit-panel-btn {
                background-color: #1e1e25;
                color: #f0eff4;
                border: 1px solid #272730;
                border-radius: 8px;
                padding: 6px 12px;
                box-shadow: none;
            }
            .forkit-panel-btn:hover {
                background-color: #272730;
            }
            .forkit-panel-btn-danger {
                background-color: rgba(251, 113, 133, 0.14);
                color: #fda4af;
                border: 1px solid rgba(251, 113, 133, 0.28);
                border-radius: 8px;
                padding: 6px 12px;
                box-shadow: none;
            }
            .forkit-panel-btn-danger:hover {
                background-color: rgba(251, 113, 133, 0.24);
            }
            .forkit-panel-icon-btn {
                background-color: transparent;
                color: #8e8d9a;
                border: none;
                border-radius: 8px;
                padding: 5px 8px;
                box-shadow: none;
            }
            .forkit-panel-icon-btn:hover {
                background-color: #1e1e25;
                color: #f0eff4;
            }
            .forkit-panel-primary {
                background-color: #a78bfa;
                color: #0c0c0f;
                font-weight: 600;
                border: none;
                border-radius: 8px;
                padding: 6px 14px;
                box-shadow: none;
            }
            .forkit-panel-primary:hover {
                background-color: #c4b5fd;
            }
            .forkit-stat-box {
                background-color: #16161b;
                border: 1px solid #272730;
                border-radius: 8px;
                padding: 12px 14px;
            }
            .forkit-stat-num {
                font-size: 22px;
                font-weight: 700;
                color: #f0eff4;
            }
            .forkit-hist-section {
                font-size: 11px;
                font-weight: 700;
                letter-spacing: 0.06em;
                color: #a78bfa;
                padding: 10px 12px 4px 12px;
            }
            .forkit-row-action {
                background-color: transparent;
                color: #8e8d9a;
                border: none;
                border-radius: 6px;
                padding: 4px 6px;
                min-width: 26px;
                min-height: 26px;
                box-shadow: none;
            }
            .forkit-row-action:hover {
                background-color: #272730;
                color: #f0eff4;
            }
            .forkit-badge-dl {
                background-color: #231f33;
                color: #a78bfa;
                border-radius: 6px;
                padding: 2px 8px;
                font-size: 11px;
                font-weight: 600;
            }
            .forkit-badge-ok {
                background-color: rgba(52, 211, 153, 0.16);
                color: #34d399;
                border-radius: 6px;
                padding: 2px 8px;
                font-size: 11px;
                font-weight: 600;
            }
            .forkit-badge-err {
                background-color: rgba(251, 113, 133, 0.16);
                color: #fb7185;
                border-radius: 6px;
                padding: 2px 8px;
                font-size: 11px;
                font-weight: 600;
            }
            progressbar.forkit-dl-bar trough {
                background-color: #101014;
                border-radius: 6px;
                min-height: 6px;
                border: none;
            }
            progressbar.forkit-dl-bar progress {
                background-image: none;
                background-color: #a78bfa;
                border-radius: 6px;
                min-height: 6px;
                border: none;
            }
            .forkit-hist-container {
                background-color: #16161b;
                border: 1px solid #272730;
                border-radius: 10px;
                padding: 6px;
            }
            list.forkit-panel-list {
                background-color: transparent;
                border-radius: 8px;
            }
            list.forkit-panel-list row {
                padding: 10px 12px;
                border-radius: 8px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.05);
                margin-bottom: 2px;
            }
            list.forkit-panel-list row:hover {
                background-color: rgba(167, 139, 250, 0.10);
            }
            .forkit-hist-nav {
                background-color: transparent;
                color: #8e8d9a;
                border: none;
                border-radius: 8px;
                padding: 9px 14px;
                font-size: 13px;
                font-weight: 500;
                box-shadow: none;
            }
            .forkit-hist-nav:hover {
                background-color: #1e1e25;
                color: #f0eff4;
            }
            .forkit-hist-nav.active {
                background-color: #231f33;
                color: #c4b5fd;
                font-weight: 600;
            }
            .forkit-hist-card-title {
                font-size: 13px;
                font-weight: 600;
                color: #f0eff4;
                padding: 10px 14px;
                border-bottom: 1px solid #272730;
                margin-bottom: 4px;
            }
            .forkit-hist-time {
                font-size: 12px;
                color: #8e8d9a;
            }
            .forkit-hist-icon {
                color: #8e8d9a;
            }
            list.forkit-dl-list {
                background-color: transparent;
            }
            list.forkit-dl-list row {
                padding: 0;
                margin-bottom: 8px;
                background-color: transparent;
            }
            list.forkit-dl-list row:hover {
                background-color: transparent;
            }
            "
        } else {
            b"
            .forkit-panel-backdrop {
                background-color: rgba(30, 22, 51, 0.35);
            }
            .forkit-panel-box {
                background-color: #ffffff;
                color: #1e1633;
                border: 1px solid #dcd3f2;
                border-radius: 10px;
                padding: 18px;
            }
            .forkit-panel-popover {
                background-color: #ffffff;
                color: #1e1633;
                border: 1px solid #dcd3f2;
                border-radius: 10px;
                padding: 16px;
            }
            .forkit-panel-full {
                background-color: #f6f4fc;
                color: #1e1633;
                border: none;
                border-radius: 0;
                padding: 24px 36px;
            }
            .forkit-panel-title {
                font-size: 16px;
                font-weight: bold;
                color: #1e1633;
            }
            .forkit-panel-title-lg {
                font-size: 20px;
                font-weight: bold;
                color: #1e1633;
            }
            .forkit-panel-muted {
                font-size: 12px;
                color: #6b5f84;
            }
            .forkit-panel-sub {
                font-size: 11px;
                color: #84779e;
            }
            .forkit-panel-item-title {
                font-size: 13px;
                font-weight: 600;
                color: #1e1633;
            }
            .forkit-panel-card {
                background-color: #f6f4fc;
                border: 1px solid #dcd3f2;
                border-radius: 8px;
                padding: 12px;
            }
            .forkit-panel-dl-card {
                background-color: #f6f4fc;
                border: 1px solid #dcd3f2;
                border-radius: 8px;
                padding: 10px 12px;
            }
            .forkit-panel-icon-badge {
                background-color: #ede9fe;
                color: #7c3aed;
                border-radius: 8px;
                padding: 7px;
            }
            .forkit-panel-search {
                background-color: #ffffff;
                color: #1e1633;
                border: 1px solid #dcd3f2;
                border-radius: 8px;
                padding: 6px 14px;
                min-height: 22px;
            }
            .forkit-panel-search:focus {
                border-color: #8b5cf6;
            }
            .forkit-panel-btn {
                background-color: #f0ebf9;
                color: #1e1633;
                border: 1px solid #dcd3f2;
                border-radius: 8px;
                padding: 6px 12px;
                box-shadow: none;
            }
            .forkit-panel-btn:hover {
                background-color: #e4dcf5;
            }
            .forkit-panel-btn-danger {
                background-color: #ffe4e6;
                color: #be123c;
                border: 1px solid #fecdd3;
                border-radius: 8px;
                padding: 6px 12px;
                box-shadow: none;
            }
            .forkit-panel-btn-danger:hover {
                background-color: #fecdd3;
            }
            .forkit-panel-icon-btn {
                background-color: transparent;
                color: #6b5f84;
                border: none;
                border-radius: 8px;
                padding: 5px 8px;
                box-shadow: none;
            }
            .forkit-panel-icon-btn:hover {
                background-color: #f0ebf9;
                color: #7c3aed;
            }
            .forkit-panel-primary {
                background-color: #8b5cf6;
                color: #ffffff;
                font-weight: 600;
                border: none;
                border-radius: 8px;
                padding: 6px 14px;
                box-shadow: none;
            }
            .forkit-panel-primary:hover {
                background-color: #7c3aed;
            }
            .forkit-stat-box {
                background-color: #ffffff;
                border: 1px solid #dcd3f2;
                border-radius: 8px;
                padding: 12px 14px;
            }
            .forkit-stat-num {
                font-size: 22px;
                font-weight: 700;
                color: #1e1633;
            }
            .forkit-hist-section {
                font-size: 11px;
                font-weight: 700;
                letter-spacing: 0.06em;
                color: #7c3aed;
                padding: 10px 12px 4px 12px;
            }
            .forkit-row-action {
                background-color: transparent;
                color: #6b5f84;
                border: none;
                border-radius: 6px;
                padding: 4px 6px;
                min-width: 26px;
                min-height: 26px;
                box-shadow: none;
            }
            .forkit-row-action:hover {
                background-color: #ede9fe;
                color: #7c3aed;
            }
            .forkit-badge-dl {
                background-color: #ede9fe;
                color: #7c3aed;
                border-radius: 6px;
                padding: 2px 8px;
                font-size: 11px;
                font-weight: 600;
            }
            .forkit-badge-ok {
                background-color: #d1fae5;
                color: #047857;
                border-radius: 6px;
                padding: 2px 8px;
                font-size: 11px;
                font-weight: 600;
            }
            .forkit-badge-err {
                background-color: #ffe4e6;
                color: #be123c;
                border-radius: 6px;
                padding: 2px 8px;
                font-size: 11px;
                font-weight: 600;
            }
            progressbar.forkit-dl-bar trough {
                background-color: #ebe6f7;
                border-radius: 6px;
                min-height: 6px;
                border: none;
            }
            progressbar.forkit-dl-bar progress {
                background-image: none;
                background-color: #8b5cf6;
                border-radius: 6px;
                min-height: 6px;
                border: none;
            }
            .forkit-hist-container {
                background-color: #ffffff;
                border: 1px solid #dcd3f2;
                border-radius: 10px;
                padding: 6px;
            }
            list.forkit-panel-list {
                background-color: transparent;
                border-radius: 8px;
            }
            list.forkit-panel-list row {
                padding: 10px 12px;
                border-radius: 8px;
                border-bottom: 1px solid #f0ebf9;
                margin-bottom: 2px;
            }
            list.forkit-panel-list row:hover {
                background-color: #f6f4fc;
            }
            .forkit-hist-nav {
                background-color: transparent;
                color: #6b5f84;
                border: none;
                border-radius: 8px;
                padding: 9px 14px;
                font-size: 13px;
                font-weight: 500;
                box-shadow: none;
            }
            .forkit-hist-nav:hover {
                background-color: #f0ebf9;
                color: #1e1633;
            }
            .forkit-hist-nav.active {
                background-color: #ede9fe;
                color: #7c3aed;
                font-weight: 600;
            }
            .forkit-hist-card-title {
                font-size: 13px;
                font-weight: 600;
                color: #1e1633;
                padding: 10px 14px;
                border-bottom: 1px solid #dcd3f2;
                margin-bottom: 4px;
            }
            .forkit-hist-time {
                font-size: 12px;
                color: #6b5f84;
            }
            .forkit-hist-icon {
                color: #6b5f84;
            }
            list.forkit-dl-list {
                background-color: transparent;
            }
            list.forkit-dl-list row {
                padding: 0;
                margin-bottom: 8px;
                background-color: transparent;
            }
            list.forkit-dl-list row:hover {
                background-color: transparent;
            }
            "
        };
        let _ = css.load_from_data(css_bytes);
        if let Some(screen) = gtk::gdk::Screen::default() {
            gtk::StyleContext::add_provider_for_screen(
                &screen,
                &css,
                gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
            );
        }
    });
}

thread_local! {
    static ACTIVE_OVERLAY: std::cell::RefCell<Option<(String, gtk::Widget)>> = const { std::cell::RefCell::new(None) };
    static ACTIVE_DOWNLOADS_LIST: std::cell::RefCell<Option<gtk::ListBox>> = const { std::cell::RefCell::new(None) };
}

fn find_gtk_overlay(app: &AppHandle) -> Option<gtk::Overlay> {
    let main_win = app.get_window("main")?;
    let vbox = main_win.default_vbox().ok()?;
    vbox.children()
        .into_iter()
        .find_map(|w| w.downcast::<gtk::Overlay>().ok())
}

fn close_active_panel_overlay(app: &AppHandle) {
    ACTIVE_DOWNLOADS_LIST.with(|cell| {
        *cell.borrow_mut() = None;
    });
    let prev = ACTIVE_OVERLAY.with(|cell| cell.borrow_mut().take());
    if let Some((_, widget)) = prev {
        if let Some(ov) = find_gtk_overlay(app) {
            ov.remove(&widget);
            ov.queue_resize();
        }
    }
}

enum OverlayPlacement {
    Centered(i32, i32),
    TopRight(i32, i32),
    FullContent,
}

fn show_in_app_overlay(
    app: &AppHandle,
    panel_id: &str,
    content: &gtk::Box,
    placement: OverlayPlacement,
) {
    ensure_panel_css(app);
    close_active_panel_overlay(app);

    let Some(ov) = find_gtk_overlay(app) else {
        return;
    };

    let backdrop = gtk::EventBox::new();
    backdrop.set_visible_window(true);
    backdrop.set_hexpand(true);
    backdrop.set_vexpand(true);
    backdrop.style_context().add_class("forkit-panel-backdrop");

    let app_bg = app.clone();
    backdrop.connect_button_press_event(move |_, _| {
        close_active_panel_overlay(&app_bg);
        gtk::glib::Propagation::Stop
    });

    let card_holder = gtk::EventBox::new();
    card_holder.set_visible_window(false);
    match placement {
        OverlayPlacement::Centered(w, h) => {
            card_holder.set_halign(gtk::Align::Center);
            card_holder.set_valign(gtk::Align::Center);
            content.set_size_request(w, h);
        }
        OverlayPlacement::TopRight(w, h) => {
            card_holder.set_halign(gtk::Align::End);
            card_holder.set_valign(gtk::Align::Start);
            card_holder.set_margin_top(8);
            card_holder.set_margin_end(14);
            content.set_size_request(w, h);
        }
        OverlayPlacement::FullContent => {
            card_holder.set_halign(gtk::Align::Fill);
            card_holder.set_valign(gtk::Align::Fill);
            card_holder.set_hexpand(true);
            card_holder.set_vexpand(true);
            content.set_hexpand(true);
            content.set_vexpand(true);
        }
    }
    card_holder.connect_button_press_event(|_, _| gtk::glib::Propagation::Stop);

    card_holder.add(content);
    backdrop.add(&card_holder);
    backdrop.show_all();

    ov.add_overlay(&backdrop);
    ov.queue_resize();

    ACTIVE_OVERLAY.with(|cell| {
        *cell.borrow_mut() = Some((panel_id.to_string(), backdrop.upcast::<gtk::Widget>()));
    });
}

pub fn open_native_panel(app: &AppHandle, panel: &str) {
    let app_clone = app.clone();
    let panel_name = panel.to_string();
    let _ = app.run_on_main_thread(move || {
        let already_same = ACTIVE_OVERLAY.with(|cell| {
            cell.borrow()
                .as_ref()
                .map(|(name, _)| name == &panel_name)
                .unwrap_or(false)
        });
        if already_same {
            close_active_panel_overlay(&app_clone);
            return;
        }
        match panel_name.as_str() {
            "dpi" => open_dpi_window(&app_clone),
            "history" => open_history_window(&app_clone),
            "downloads" => open_downloads_window(&app_clone),
            "extensions" => open_extensions_window(&app_clone),
            _ => {}
        }
    });
}

fn open_dpi_window(app: &AppHandle) {
    let root = gtk::Box::new(gtk::Orientation::Vertical, 12);
    root.style_context().add_class("forkit-panel-popover");

    let (enabled, blocked_total, rule_count, custom_count) = app
        .try_state::<AdBlockerState>()
        .and_then(|s| {
            s.inner.lock().ok().map(|b| {
                let rules = b.block_patterns.len() + b.cosmetic_count + 42;
                (b.is_enabled, b.stats.blocked, rules, b.block_patterns.len())
            })
        })
        .unwrap_or((true, 0, 42, 0));

    let active_host: Option<String> = app.try_state::<NativeUiState>().and_then(|ui| {
        let active_id = *ui.active_tab_id.lock().unwrap();
        let tabs = ui.tabs.lock().unwrap();
        tabs.iter()
            .find(|t| Some(t.tab_id) == active_id)
            .and_then(|t| url::Url::parse(&t.url).ok())
            .and_then(|u| {
                if u.scheme() == "http" || u.scheme() == "https" {
                    u.host_str().map(|h| h.to_string())
                } else {
                    None
                }
            })
    });

    // Header: Shield icon + Title + Status badge + Close icon
    let hdr_row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let shield_icon = gtk::Image::from_icon_name(
        Some("security-high-symbolic"),
        gtk::IconSize::Menu,
    );
    let header = gtk::Label::new(Some("Protection"));
    header.style_context().add_class("forkit-panel-title");
    header.set_xalign(0.0);

    let status_pill = gtk::Label::new(Some(if enabled { "Active" } else { "Paused" }));
    status_pill
        .style_context()
        .add_class(if enabled { "forkit-badge-ok" } else { "forkit-badge-err" });
    status_pill.set_valign(gtk::Align::Center);

    let close_btn = gtk::Button::from_icon_name(
        Some("window-close-symbolic"),
        gtk::IconSize::Menu,
    );
    close_btn.style_context().add_class("forkit-panel-icon-btn");
    close_btn.set_tooltip_text(Some("Close"));
    let app_cl = app.clone();
    close_btn.connect_clicked(move |_| close_active_panel_overlay(&app_cl));

    hdr_row.pack_start(&shield_icon, false, false, 0);
    hdr_row.pack_start(&header, false, false, 0);
    hdr_row.pack_start(&status_pill, false, false, 4);
    hdr_row.pack_end(&close_btn, false, false, 0);
    root.pack_start(&hdr_row, false, false, 0);

    // Master toggle card
    let toggle_card = gtk::Box::new(gtk::Orientation::Horizontal, 12);
    toggle_card.style_context().add_class("forkit-panel-card");
    let toggle_text = gtk::Box::new(gtk::Orientation::Vertical, 2);
    let toggle_lbl = gtk::Label::new(Some("Ad & Tracker Shield"));
    toggle_lbl.style_context().add_class("forkit-panel-item-title");
    toggle_lbl.set_xalign(0.0);
    let toggle_sub = gtk::Label::new(Some("Blocks ads, trackers & YouTube pre-rolls"));
    toggle_sub.style_context().add_class("forkit-panel-muted");
    toggle_sub.set_xalign(0.0);
    toggle_text.pack_start(&toggle_lbl, false, false, 0);
    toggle_text.pack_start(&toggle_sub, false, false, 0);

    let sw = gtk::Switch::new();
    sw.set_active(enabled);
    sw.set_valign(gtk::Align::Center);
    let app_sw = app.clone();
    let pill_sw = status_pill.clone();
    sw.connect_state_set(move |_, active| {
        if let Some(ad_state) = app_sw.try_state::<AdBlockerState>() {
            if let Ok(mut blocker) = ad_state.inner.lock() {
                blocker.is_enabled = active;
            }
        }
        crate::adblocker::sync_webkit_adblock_enabled(&app_sw, active);
        pill_sw.set_text(if active { "Active" } else { "Paused" });
        pill_sw
            .style_context()
            .remove_class(if active { "forkit-badge-err" } else { "forkit-badge-ok" });
        pill_sw
            .style_context()
            .add_class(if active { "forkit-badge-ok" } else { "forkit-badge-err" });

        if let Some(ui_st) = app_sw.try_state::<NativeUiState>() {
            if let Some(id) = *ui_st.active_tab_id.lock().unwrap() {
                let _ = reload_tab(app_sw.clone(), id);
            }
        }
        gtk::glib::Propagation::Proceed
    });
    toggle_card.pack_start(&toggle_text, true, true, 0);
    toggle_card.pack_end(&sw, false, false, 0);
    root.pack_start(&toggle_card, false, false, 0);

    // 2-Column metric grid
    let metrics_row = gtk::Box::new(gtk::Orientation::Horizontal, 10);
    metrics_row.set_homogeneous(true);

    let blocked_box = gtk::Box::new(gtk::Orientation::Vertical, 2);
    blocked_box.style_context().add_class("forkit-stat-box");
    let blocked_num = gtk::Label::new(Some(&blocked_total.to_string()));
    blocked_num.style_context().add_class("forkit-stat-num");
    blocked_num.set_xalign(0.0);
    let blocked_cap = gtk::Label::new(Some("Requests blocked"));
    blocked_cap.style_context().add_class("forkit-panel-muted");
    blocked_cap.set_xalign(0.0);
    blocked_box.pack_start(&blocked_num, false, false, 0);
    blocked_box.pack_start(&blocked_cap, false, false, 0);

    let rules_box = gtk::Box::new(gtk::Orientation::Vertical, 2);
    rules_box.style_context().add_class("forkit-stat-box");
    let rules_num = gtk::Label::new(Some(&rule_count.to_string()));
    rules_num.style_context().add_class("forkit-stat-num");
    rules_num.set_xalign(0.0);
    let rules_cap = gtk::Label::new(Some(&format!("Active rules ({} custom)", custom_count)));
    rules_cap.style_context().add_class("forkit-panel-muted");
    rules_cap.set_xalign(0.0);
    rules_box.pack_start(&rules_num, false, false, 0);
    rules_box.pack_start(&rules_cap, false, false, 0);

    metrics_row.pack_start(&blocked_box, true, true, 0);
    metrics_row.pack_start(&rules_box, true, true, 0);
    root.pack_start(&metrics_row, false, false, 0);

    // Current site quick-whitelist row
    if let Some(host) = active_host {
        let is_whitelisted = app
            .try_state::<AdBlockerState>()
            .and_then(|s| {
                s.inner
                    .lock()
                    .ok()
                    .map(|b| b.allow_patterns.iter().any(|p| p == &host.to_lowercase()))
            })
            .unwrap_or(false);

        let site_card = gtk::Box::new(gtk::Orientation::Horizontal, 10);
        site_card.style_context().add_class("forkit-panel-card");
        let site_lbl = gtk::Label::new(Some(&host));
        site_lbl.style_context().add_class("forkit-panel-item-title");
        site_lbl.set_xalign(0.0);
        site_lbl.set_ellipsize(gtk::pango::EllipsizeMode::End);

        let wl_btn = gtk::Button::with_label(if is_whitelisted {
            "Whitelisted"
        } else {
            "Allow Site"
        });
        wl_btn.style_context().add_class("forkit-panel-btn");
        wl_btn.set_sensitive(!is_whitelisted);
        let app_wl = app.clone();
        let host_wl = host.clone();
        let wl_btn_c = wl_btn.clone();
        wl_btn.connect_clicked(move |_| {
            if let Some(ad_state) = app_wl.try_state::<AdBlockerState>() {
                if let Ok(mut blocker) = ad_state.inner.lock() {
                    blocker.add_to_whitelist(&host_wl);
                }
            }
            wl_btn_c.set_label("Whitelisted");
            wl_btn_c.set_sensitive(false);
            if let Some(ui_st) = app_wl.try_state::<NativeUiState>() {
                if let Some(id) = *ui_st.active_tab_id.lock().unwrap() {
                    let _ = reload_tab(app_wl.clone(), id);
                }
            }
        });
        site_card.pack_start(&site_lbl, true, true, 0);
        site_card.pack_end(&wl_btn, false, false, 0);
        root.pack_start(&site_card, false, false, 0);
    }

    // Custom filter input
    let filter_card = gtk::Box::new(gtk::Orientation::Vertical, 8);
    filter_card.style_context().add_class("forkit-panel-card");
    let filter_lbl = gtk::Label::new(Some("Custom Filter Rule"));
    filter_lbl.style_context().add_class("forkit-panel-item-title");
    filter_lbl.set_xalign(0.0);
    let filter_row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let filter_entry = gtk::Entry::new();
    filter_entry.style_context().add_class("forkit-address");
    filter_entry.set_placeholder_text(Some("ads.example.com"));
    filter_entry.set_hexpand(true);
    let add_filter_btn = gtk::Button::with_label("Add");
    add_filter_btn.style_context().add_class("forkit-panel-primary");

    let add_rule = {
        let app_flt = app.clone();
        let entry_flt = filter_entry.clone();
        let rules_num_c = rules_num.clone();
        let rules_cap_c = rules_cap.clone();
        move || {
            let pat = entry_flt.text().trim().to_string();
            if pat.is_empty() {
                return;
            }
            if let Some(ad_state) = app_flt.try_state::<AdBlockerState>() {
                if let Ok(mut blocker) = ad_state.inner.lock() {
                    blocker.add_custom_filter(&pat);
                    let total = blocker.block_patterns.len() + blocker.cosmetic_count + 42;
                    rules_num_c.set_text(&total.to_string());
                    rules_cap_c.set_text(&format!(
                        "Active rules ({} custom)",
                        blocker.block_patterns.len()
                    ));
                }
            }
            entry_flt.set_text("");
        }
    };

    let add_rule_btn = add_rule.clone();
    add_filter_btn.connect_clicked(move |_| add_rule_btn());
    filter_entry.connect_activate(move |_| add_rule());

    filter_row.pack_start(&filter_entry, true, true, 0);
    filter_row.pack_end(&add_filter_btn, false, false, 0);
    filter_card.pack_start(&filter_lbl, false, false, 0);
    filter_card.pack_start(&filter_row, false, false, 0);
    root.pack_start(&filter_card, false, false, 0);

    // Footer actions: Reset Stats
    let footer_row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let reset_btn = gtk::Button::with_label("Reset Counter");
    reset_btn.style_context().add_class("forkit-panel-btn");
    let app_rst = app.clone();
    let blocked_num_rst = blocked_num.clone();
    reset_btn.connect_clicked(move |_| {
        if let Some(ad_state) = app_rst.try_state::<AdBlockerState>() {
            if let Ok(mut blocker) = ad_state.inner.lock() {
                blocker.stats.blocked = 0;
                blocker.stats.allowed = 0;
                blocker.save_stats();
            }
        }
        blocked_num_rst.set_text("0");
    });
    footer_row.pack_start(&reset_btn, false, false, 0);
    root.pack_end(&footer_row, false, false, 0);

    show_in_app_overlay(app, "dpi", &root, OverlayPlacement::TopRight(410, 460));
}

fn format_bytes(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    let b = bytes as f64;
    if b >= GB {
        format!("{:.2} GB", b / GB)
    } else if b >= MB {
        format!("{:.1} MB", b / MB)
    } else if b >= KB {
        format!("{:.0} KB", b / KB)
    } else {
        format!("{} B", bytes)
    }
}

fn format_relative_time(ts: u64, now: u64) -> String {
    if ts == 0 || now < ts {
        return String::new();
    }
    let diff = now - ts;
    if diff < 60 {
        "Just now".to_string()
    } else if diff < 3600 {
        format!("{}m ago", diff / 60)
    } else if diff < 86_400 {
        format!("{}h ago", diff / 3600)
    } else if diff < 172_800 {
        "Yesterday".to_string()
    } else {
        format!("{}d ago", diff / 86_400)
    }
}

fn build_empty_state(icon_name: &str, title_text: &str, sub_text: &str) -> gtk::Box {
    let box_ = gtk::Box::new(gtk::Orientation::Vertical, 8);
    box_.set_halign(gtk::Align::Center);
    box_.set_valign(gtk::Align::Center);
    box_.set_margin_top(48);
    box_.set_margin_bottom(48);
    box_.set_margin_start(16);
    box_.set_margin_end(16);

    let icon = gtk::Image::from_icon_name(Some(icon_name), gtk::IconSize::Dialog);
    icon.style_context().add_class("forkit-panel-muted");
    let title = gtk::Label::new(Some(title_text));
    title.style_context().add_class("forkit-panel-item-title");
    let sub = gtk::Label::new(Some(sub_text));
    sub.style_context().add_class("forkit-panel-muted");
    sub.set_line_wrap(true);
    sub.set_justify(gtk::Justification::Center);
    sub.set_max_width_chars(38);

    box_.pack_start(&icon, false, false, 0);
    box_.pack_start(&title, false, false, 0);
    box_.pack_start(&sub, false, false, 0);
    box_
}

fn history_time_bucket(ts: u64, now: u64) -> &'static str {
    let diff = now.saturating_sub(ts);
    if diff < 86_400 {
        "TODAY"
    } else if diff < 172_800 {
        "YESTERDAY"
    } else if diff < 604_800 {
        "THIS WEEK"
    } else {
        "OLDER"
    }
}

fn format_host_and_path(raw_url: &str) -> String {
    if let Ok(parsed) = url::Url::parse(raw_url) {
        if let Some(host) = parsed.host_str() {
            let path = parsed.path();
            if path.is_empty() || path == "/" {
                return host.to_string();
            }
            return format!("{}{}", host, path);
        }
    }
    raw_url.to_string()
}

fn open_history_window(app: &AppHandle) {
    let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
    root.style_context().add_class("forkit-panel-full");

    let page_wrap = gtk::Box::new(gtk::Orientation::Vertical, 18);
    page_wrap.set_hexpand(true);
    page_wrap.set_vexpand(true);

    // Top bar (Chrome-style: Title on left, centered search bar, close on right)
    let top_row = gtk::Box::new(gtk::Orientation::Horizontal, 16);
    let title_box = gtk::Box::new(gtk::Orientation::Horizontal, 10);
    title_box.set_size_request(220, -1);
    let title_icon = gtk::Image::from_icon_name(
        Some("document-open-recent-symbolic"),
        gtk::IconSize::LargeToolbar,
    );
    let title_lbl = gtk::Label::new(Some("History"));
    title_lbl.style_context().add_class("forkit-panel-title-lg");
    title_box.pack_start(&title_icon, false, false, 0);
    title_box.pack_start(&title_lbl, false, false, 0);

    let search = gtk::SearchEntry::new();
    search.style_context().add_class("forkit-panel-search");
    search.set_placeholder_text(Some("Search history"));
    search.set_size_request(520, -1);
    search.set_halign(gtk::Align::Center);

    let close_btn = gtk::Button::from_icon_name(
        Some("window-close-symbolic"),
        gtk::IconSize::Menu,
    );
    close_btn.style_context().add_class("forkit-panel-icon-btn");
    close_btn.set_tooltip_text(Some("Close"));
    let app_cl_h = app.clone();
    close_btn.connect_clicked(move |_| close_active_panel_overlay(&app_cl_h));

    top_row.pack_start(&title_box, false, false, 0);
    top_row.pack_start(&search, true, false, 0);
    top_row.pack_end(&close_btn, false, false, 0);
    page_wrap.pack_start(&top_row, false, false, 0);

    // Body: Left sidebar + Right date-grouped cards
    let body_row = gtk::Box::new(gtk::Orientation::Horizontal, 24);
    body_row.set_vexpand(true);
    body_row.set_hexpand(true);

    let sidebar = gtk::Box::new(gtk::Orientation::Vertical, 4);
    sidebar.set_size_request(220, -1);
    sidebar.set_valign(gtk::Align::Start);

    let nav_all_btn = gtk::Button::new();
    nav_all_btn.style_context().add_class("forkit-hist-nav");
    nav_all_btn.style_context().add_class("active");
    let nav_all_box = gtk::Box::new(gtk::Orientation::Horizontal, 10);
    let nav_all_ico = gtk::Image::from_icon_name(Some("document-open-recent-symbolic"), gtk::IconSize::Menu);
    let nav_all_lbl = gtk::Label::new(Some("Forkit history"));
    nav_all_lbl.set_xalign(0.0);
    nav_all_box.pack_start(&nav_all_ico, false, false, 0);
    nav_all_box.pack_start(&nav_all_lbl, true, true, 0);
    nav_all_btn.add(&nav_all_box);

    let clear_btn = gtk::Button::new();
    clear_btn.style_context().add_class("forkit-hist-nav");
    let clear_box = gtk::Box::new(gtk::Orientation::Horizontal, 10);
    let clear_ico = gtk::Image::from_icon_name(Some("user-trash-symbolic"), gtk::IconSize::Menu);
    let clear_lbl = gtk::Label::new(Some("Delete browsing data"));
    clear_lbl.set_xalign(0.0);
    clear_box.pack_start(&clear_ico, false, false, 0);
    clear_box.pack_start(&clear_lbl, true, true, 0);
    clear_btn.add(&clear_box);

    sidebar.pack_start(&nav_all_btn, false, false, 0);
    sidebar.pack_start(&clear_btn, false, false, 0);
    body_row.pack_start(&sidebar, false, false, 0);

    let scroll = gtk::ScrolledWindow::new(None::<&gtk::Adjustment>, None::<&gtk::Adjustment>);
    scroll.set_policy(gtk::PolicyType::Never, gtk::PolicyType::Automatic);
    scroll.set_vexpand(true);
    scroll.set_hexpand(true);

    let cards_outer = gtk::Box::new(gtk::Orientation::Vertical, 0);
    cards_outer.set_halign(gtk::Align::Center);
    cards_outer.set_size_request(780, -1);

    let cards_box = gtk::Box::new(gtk::Orientation::Vertical, 16);
    cards_box.set_hexpand(true);
    cards_outer.pack_start(&cards_box, false, false, 0);
    scroll.add(&cards_outer);

    body_row.pack_start(&scroll, true, true, 0);
    page_wrap.pack_start(&body_row, true, true, 0);
    root.pack_start(&page_wrap, true, true, 0);

    let populate: std::rc::Rc<dyn Fn(&str)> = {
        let app_p = app.clone();
        let cards_p = cards_box.clone();
        let nav_lbl_p = nav_all_lbl.clone();
        std::rc::Rc::new(move |query: &str| {
            for ch in cards_p.children() {
                cards_p.remove(&ch);
            }
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let q = query.trim().to_lowercase();
            let entries: Vec<HistoryEntry> = app_p
                .try_state::<NativePanelsState>()
                .map(|s| s.history.lock().unwrap().iter().rev().cloned().collect())
                .unwrap_or_default();

            let mut count = 0usize;
            let mut last_bucket: Option<&str> = None;
            let mut current_list: Option<gtk::ListBox> = None;

            for item in entries {
                if !q.is_empty()
                    && !item.title.to_lowercase().contains(&q)
                    && !item.url.to_lowercase().contains(&q)
                {
                    continue;
                }
                count += 1;

                let bucket = history_time_bucket(item.timestamp, now);
                if last_bucket != Some(bucket) {
                    last_bucket = Some(bucket);
                    let card = gtk::Box::new(gtk::Orientation::Vertical, 0);
                    card.style_context().add_class("forkit-hist-container");

                    let hdr_lbl = gtk::Label::new(Some(bucket));
                    hdr_lbl.style_context().add_class("forkit-hist-card-title");
                    hdr_lbl.set_xalign(0.0);
                    card.pack_start(&hdr_lbl, false, false, 0);

                    let lb = gtk::ListBox::new();
                    lb.style_context().add_class("forkit-panel-list");
                    lb.set_selection_mode(gtk::SelectionMode::None);
                    let app_act = app_p.clone();
                    lb.connect_row_activated(move |_, row| {
                        let url_opt = unsafe {
                            row.data::<String>("forkit_hist_url").map(|p| p.as_ref().clone())
                        };
                        if let Some(url) = url_opt {
                            let app_idle = app_act.clone();
                            gtk::glib::idle_add_local_once(move || {
                                close_active_panel_overlay(&app_idle);
                                if let Some(ui_st) = app_idle.try_state::<NativeUiState>() {
                                    let active_id = *ui_st.active_tab_id.lock().unwrap();
                                    if let Some(id) = active_id {
                                        let _ = navigate_tab(app_idle.clone(), id, url);
                                    }
                                }
                            });
                        }
                    });
                    card.pack_start(&lb, false, false, 0);
                    cards_p.pack_start(&card, false, false, 0);
                    current_list = Some(lb);
                }

                let Some(ref list_p) = current_list else {
                    continue;
                };

                let row = gtk::ListBoxRow::new();
                let hbox = gtk::Box::new(gtk::Orientation::Horizontal, 10);

                let rel = format_relative_time(item.timestamp, now);
                let time_lbl = gtk::Label::new(Some(&rel));
                time_lbl.style_context().add_class("forkit-hist-time");
                time_lbl.set_size_request(58, -1);
                time_lbl.set_xalign(0.0);
                time_lbl.set_valign(gtk::Align::Center);

                let globe = gtk::Image::from_icon_name(
                    Some("applications-internet-symbolic"),
                    gtk::IconSize::Menu,
                );
                globe.style_context().add_class("forkit-hist-icon");
                globe.set_valign(gtk::Align::Center);

                let display_title = if item.title.trim().is_empty() {
                    item.url.as_str()
                } else {
                    item.title.as_str()
                };
                let t = gtk::Label::new(Some(display_title));
                t.style_context().add_class("forkit-panel-item-title");
                t.set_xalign(0.0);
                t.set_ellipsize(gtk::pango::EllipsizeMode::End);
                t.set_valign(gtk::Align::Center);

                let clean_sub = format_host_and_path(&item.url);
                let u = gtk::Label::new(Some(&clean_sub));
                u.style_context().add_class("forkit-panel-muted");
                u.set_xalign(0.0);
                u.set_ellipsize(gtk::pango::EllipsizeMode::End);
                u.set_valign(gtk::Align::Center);

                let text_row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
                text_row.set_hexpand(true);
                text_row.pack_start(&t, false, false, 0);
                text_row.pack_start(&u, true, true, 0);

                let new_tab_btn = gtk::Button::from_icon_name(
                    Some("tab-new-symbolic"),
                    gtk::IconSize::Menu,
                );
                new_tab_btn.style_context().add_class("forkit-row-action");
                new_tab_btn.set_tooltip_text(Some("Open in new tab"));
                new_tab_btn.set_valign(gtk::Align::Center);
                let app_nt = app_p.clone();
                let url_nt = item.url.clone();
                new_tab_btn.connect_clicked(move |_| {
                    let app_i = app_nt.clone();
                    let u_i = url_nt.clone();
                    gtk::glib::idle_add_local_once(move || {
                        close_active_panel_overlay(&app_i);
                        crate::gtk_ui::create_native_tab(&app_i, &u_i);
                    });
                });

                let del_btn = gtk::Button::from_icon_name(
                    Some("window-close-symbolic"),
                    gtk::IconSize::Menu,
                );
                del_btn.style_context().add_class("forkit-row-action");
                del_btn.set_tooltip_text(Some("Remove"));
                del_btn.set_valign(gtk::Align::Center);
                let app_del = app_p.clone();
                let url_del = item.url.clone();
                let ts_del = item.timestamp;
                let row_del = row.clone();
                let list_del = list_p.clone();
                let nav_lbl_del = nav_lbl_p.clone();
                del_btn.connect_clicked(move |_| {
                    if let Some(st) = app_del.try_state::<NativePanelsState>() {
                        let mut hist = st.history.lock().unwrap();
                        if let Some(pos) = hist
                            .iter()
                            .rposition(|e| e.timestamp == ts_del && e.url == url_del)
                        {
                            hist.remove(pos);
                        }
                        drop(hist);
                        persist_history(&st);
                        let remaining = st.history.lock().unwrap().len();
                        nav_lbl_del.set_text(&format!("Forkit history ({})", remaining));
                    }
                    list_del.remove(&row_del);
                });

                hbox.pack_start(&time_lbl, false, false, 0);
                hbox.pack_start(&globe, false, false, 0);
                hbox.pack_start(&text_row, true, true, 0);
                hbox.pack_end(&del_btn, false, false, 0);
                hbox.pack_end(&new_tab_btn, false, false, 0);

                row.add(&hbox);
                unsafe {
                    row.set_data("forkit_hist_url", item.url);
                }
                list_p.add(&row);
            }

            nav_lbl_p.set_text(&format!("Forkit history ({})", count));
            if count == 0 {
                let card = gtk::Box::new(gtk::Orientation::Vertical, 0);
                card.style_context().add_class("forkit-hist-container");
                let msg = if q.is_empty() {
                    "Pages you visit will appear here"
                } else {
                    "No matching history entries"
                };
                card.pack_start(
                    &build_empty_state("document-open-recent-symbolic", "No history found", msg),
                    false,
                    false,
                    16,
                );
                cards_p.pack_start(&card, false, false, 0);
            }
            cards_p.show_all();
        })
    };

    populate("");

    let pop_search = populate.clone();
    search.connect_search_changed(move |s| {
        pop_search(&s.text());
    });

    let pop_all = populate.clone();
    let search_clr_q = search.clone();
    nav_all_btn.connect_clicked(move |_| {
        pop_all(&search_clr_q.text());
    });

    let app_clr = app.clone();
    let pop_clr = populate.clone();
    clear_btn.connect_clicked(move |_| {
        if let Some(st) = app_clr.try_state::<NativePanelsState>() {
            st.history.lock().unwrap().clear();
            persist_history(&st);
        }
        pop_clr("");
    });

    show_in_app_overlay(app, "history", &root, OverlayPlacement::FullContent);
}

fn populate_downloads_list(app: &AppHandle, list: &gtk::ListBox) {
    for ch in list.children() {
        list.remove(&ch);
    }

    let items: Vec<DownloadEntry> = app
        .try_state::<NativePanelsState>()
        .map(|s| s.downloads.lock().unwrap().iter().rev().cloned().collect())
        .unwrap_or_default();

    if items.is_empty() {
        let row = gtk::ListBoxRow::new();
        row.set_activatable(false);
        row.set_selectable(false);
        row.add(&build_empty_state(
            "folder-download-symbolic",
            "No downloads yet",
            "Files you download will appear here",
        ));
        list.add(&row);
        list.show_all();
        return;
    }

    for d in items {
        let row = gtk::ListBoxRow::new();
        row.set_activatable(false);
        row.set_selectable(false);

        let card = gtk::Box::new(gtk::Orientation::Vertical, 6);
        card.style_context().add_class("forkit-panel-dl-card");

        let header = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let file_icon = gtk::Image::from_icon_name(
            Some("text-x-generic-symbolic"),
            gtk::IconSize::Menu,
        );
        let name = gtk::Label::new(Some(&d.file_name));
        name.style_context().add_class("forkit-panel-item-title");
        name.set_xalign(0.0);
        name.set_ellipsize(gtk::pango::EllipsizeMode::Middle);
        name.set_hexpand(true);

        let badge_text = if d.status == "Downloading" {
            if d.total_size > 0 {
                format!("{}%", d.progress)
            } else {
                "Downloading".to_string()
            }
        } else if d.status == "Completed" {
            "Done".to_string()
        } else {
            "Failed".to_string()
        };
        let badge = gtk::Label::new(Some(&badge_text));
        if d.status == "Downloading" {
            badge.style_context().add_class("forkit-badge-dl");
        } else if d.status == "Completed" {
            badge.style_context().add_class("forkit-badge-ok");
        } else {
            badge.style_context().add_class("forkit-badge-err");
        }

        let mode_text = if d.channels > 1 {
            format!("Multi ({}x)", d.channels)
        } else {
            "Single".to_string()
        };
        let mode_badge = gtk::Label::new(Some(&mode_text));
        mode_badge.style_context().add_class("forkit-panel-sub");

        header.pack_start(&file_icon, false, false, 0);
        header.pack_start(&name, true, true, 0);
        header.pack_end(&badge, false, false, 0);
        header.pack_end(&mode_badge, false, false, 0);
        card.pack_start(&header, false, false, 0);

        if d.status == "Downloading" {
            let bar = gtk::ProgressBar::new();
            bar.style_context().add_class("forkit-dl-bar");
            if d.total_size > 0 {
                bar.set_fraction((d.progress as f64 / 100.0).clamp(0.0, 1.0));
            } else {
                bar.set_fraction(0.35);
            }
            card.pack_start(&bar, false, false, 0);
        }

        let footer = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let info_str = if d.status == "Downloading" {
            if d.total_size > 0 {
                format!(
                    "{} / {}",
                    format_bytes(d.downloaded),
                    format_bytes(d.total_size)
                )
            } else if d.downloaded > 0 {
                format!("{} downloaded", format_bytes(d.downloaded))
            } else {
                "Starting download...".to_string()
            }
        } else if d.status == "Completed" && !d.path.is_empty() {
            let p = std::path::Path::new(&d.path);
            p.parent()
                .map(|dir| dir.to_string_lossy().to_string())
                .unwrap_or_else(|| d.path.clone())
        } else {
            d.status.clone()
        };
        let info = gtk::Label::new(Some(&info_str));
        info.style_context().add_class("forkit-panel-sub");
        info.set_xalign(0.0);
        info.set_ellipsize(gtk::pango::EllipsizeMode::Start);
        info.set_hexpand(true);
        footer.pack_start(&info, true, true, 0);

        if d.status == "Completed" && !d.path.is_empty() {
            let open_btn = gtk::Button::with_label("Open Folder");
            open_btn.style_context().add_class("forkit-panel-btn");
            let folder_path = std::path::Path::new(&d.path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| d.path.clone());
            open_btn.connect_clicked(move |_| {
                let _ = std::process::Command::new("xdg-open")
                    .arg(&folder_path)
                    .spawn();
            });
            footer.pack_end(&open_btn, false, false, 0);
        }

        card.pack_start(&footer, false, false, 0);
        row.add(&card);
        list.add(&row);
    }

    list.show_all();
}

fn open_downloads_window(app: &AppHandle) {
    let root = gtk::Box::new(gtk::Orientation::Vertical, 12);
    root.style_context().add_class("forkit-panel-popover");

    let top_row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let title_icon = gtk::Image::from_icon_name(
        Some("folder-download-symbolic"),
        gtk::IconSize::Menu,
    );
    let title = gtk::Label::new(Some("Downloads"));
    title.style_context().add_class("forkit-panel-title");
    title.set_xalign(0.0);
    title.set_hexpand(true);

    let clear_btn = gtk::Button::with_label("Clear");
    clear_btn.style_context().add_class("forkit-panel-btn");
    let close_btn = gtk::Button::from_icon_name(
        Some("window-close-symbolic"),
        gtk::IconSize::Menu,
    );
    close_btn.style_context().add_class("forkit-panel-icon-btn");
    close_btn.set_tooltip_text(Some("Close"));
    let app_cl_d = app.clone();
    close_btn.connect_clicked(move |_| close_active_panel_overlay(&app_cl_d));

    top_row.pack_start(&title_icon, false, false, 0);
    top_row.pack_start(&title, true, true, 0);
    top_row.pack_end(&close_btn, false, false, 0);
    top_row.pack_end(&clear_btn, false, false, 0);
    root.pack_start(&top_row, false, false, 0);

    let scroll = gtk::ScrolledWindow::new(None::<&gtk::Adjustment>, None::<&gtk::Adjustment>);
    scroll.set_policy(gtk::PolicyType::Never, gtk::PolicyType::Automatic);
    scroll.set_vexpand(true);
    let list = gtk::ListBox::new();
    list.style_context().add_class("forkit-dl-list");
    list.set_selection_mode(gtk::SelectionMode::None);
    scroll.add(&list);
    root.pack_start(&scroll, true, true, 0);

    populate_downloads_list(app, &list);

    let app_clr = app.clone();
    let list_clr = list.clone();
    clear_btn.connect_clicked(move |_| {
        if let Some(st) = app_clr.try_state::<NativePanelsState>() {
            st.downloads.lock().unwrap().clear();
        }
        populate_downloads_list(&app_clr, &list_clr);
    });

    show_in_app_overlay(app, "downloads", &root, OverlayPlacement::TopRight(400, 460));
    ACTIVE_DOWNLOADS_LIST.with(|cell| {
        *cell.borrow_mut() = Some(list);
    });
}

fn open_extensions_window(app: &AppHandle) {
    let root = gtk::Box::new(gtk::Orientation::Vertical, 10);
    root.style_context().add_class("forkit-panel-box");

    let top_row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let title_icon = gtk::Image::from_icon_name(
        Some("application-x-addon-symbolic"),
        gtk::IconSize::Menu,
    );
    let title = gtk::Label::new(Some("Extensions"));
    title.style_context().add_class("forkit-panel-title");
    title.set_xalign(0.0);
    title.set_hexpand(true);

    let load_btn = gtk::Button::with_label("+ Load Unpacked");
    load_btn.style_context().add_class("forkit-panel-btn");

    let close_btn = gtk::Button::from_icon_name(
        Some("window-close-symbolic"),
        gtk::IconSize::Menu,
    );
    close_btn.style_context().add_class("forkit-panel-icon-btn");
    close_btn.set_tooltip_text(Some("Close"));
    let app_cl = app.clone();
    close_btn.connect_clicked(move |_| close_active_panel_overlay(&app_cl));

    top_row.pack_start(&title_icon, false, false, 0);
    top_row.pack_start(&title, true, true, 0);
    top_row.pack_end(&close_btn, false, false, 0);
    top_row.pack_end(&load_btn, false, false, 0);
    root.pack_start(&top_row, false, false, 0);

    let cws_row = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    let cws_entry = gtk::Entry::new();
    cws_entry.style_context().add_class("forkit-panel-input");
    cws_entry.set_placeholder_text(Some("Chrome Web Store URL or Extension ID..."));
    cws_entry.set_hexpand(true);
    let cws_btn = gtk::Button::with_label("Install");
    cws_btn.style_context().add_class("forkit-panel-btn");
    cws_row.pack_start(&cws_entry, true, true, 0);
    cws_row.pack_end(&cws_btn, false, false, 0);
    root.pack_start(&cws_row, false, false, 0);

    let status_lbl = gtk::Label::new(None);
    status_lbl.set_xalign(0.0);
    status_lbl.set_line_wrap(true);
    status_lbl.set_no_show_all(true);
    root.pack_start(&status_lbl, false, false, 0);

    let scroll = gtk::ScrolledWindow::new(None::<&gtk::Adjustment>, None::<&gtk::Adjustment>);
    scroll.set_policy(gtk::PolicyType::Never, gtk::PolicyType::Automatic);
    scroll.set_vexpand(true);
    let list = gtk::ListBox::new();
    list.style_context().add_class("forkit-dl-list");
    list.set_selection_mode(gtk::SelectionMode::None);
    scroll.add(&list);
    root.pack_start(&scroll, true, true, 0);

    populate_extensions_list(app, &list, &status_lbl);

    let app_ld = app.clone();
    let list_ld = list.clone();
    let status_ld = status_lbl.clone();
    load_btn.connect_clicked(move |_| {
        if let Some(folder) = rfd::FileDialog::new()
            .set_title("Select Chrome Extension Folder (manifest.json)")
            .pick_folder()
        {
            let res = if let Some(st) = app_ld.try_state::<crate::extensions::ExtensionManagerState>() {
                st.inner.lock().unwrap().load_unpacked(&folder)
            } else {
                Err("Extension manager unavailable".to_string())
            };
            match res {
                Ok(ext) => {
                    status_ld.set_text(&format!("Loaded '{}' (reload open tabs to apply)", ext.name));
                    status_ld.show();
                    apply_extensions_to_open_tabs(&app_ld, Some((&ext.id, true)));
                    populate_extensions_list(&app_ld, &list_ld, &status_ld);
                }
                Err(err) => {
                    status_ld.set_text(&format!("Error: {}", err));
                    status_ld.show();
                }
            }
        }
    });

    let app_cws = app.clone();
    let list_cws = list.clone();
    let status_cws = status_lbl.clone();
    let entry_cws = cws_entry.clone();
    let btn_cws = cws_btn.clone();
    cws_btn.connect_clicked(move |_| {
        let input = entry_cws.text().to_string();
        if input.trim().is_empty() {
            return;
        }
        btn_cws.set_sensitive(false);
        status_cws.set_text("Downloading from Chrome Web Store...");
        status_cws.show();

        let app_bg = app_cws.clone();
        let app_ui = app_cws.clone();
        let list_bg = list_cws.clone();
        let status_bg = status_cws.clone();
        let btn_bg = btn_cws.clone();
        let entry_bg = entry_cws.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        tauri::async_runtime::spawn(async move {
            let res = crate::extensions::install_from_chrome_web_store(&app_bg, &input).await;
            let _ = tx.send(res);
        });
        gtk::glib::MainContext::default().spawn_local(async move {
            if let Ok(res) = rx.await {
                btn_bg.set_sensitive(true);
                match res {
                    Ok(ext) => {
                        entry_bg.set_text("");
                        status_bg.set_text(&format!("Installed '{}'", ext.name));
                        apply_extensions_to_open_tabs(&app_ui, Some((&ext.id, true)));
                        populate_extensions_list(&app_ui, &list_bg, &status_bg);
                    }
                    Err(err) => {
                        status_bg.set_text(&format!("Error: {}", err));
                    }
                }
            }
        });
    });

    show_in_app_overlay(app, "extensions", &root, OverlayPlacement::TopRight(440, 500));
}

fn populate_extensions_list(app: &AppHandle, list: &gtk::ListBox, status_lbl: &gtk::Label) {
    for child in list.children() {
        list.remove(&child);
    }

    let extensions = app
        .try_state::<crate::extensions::ExtensionManagerState>()
        .map(|s| s.inner.lock().unwrap().extensions.clone())
        .unwrap_or_default();

    if extensions.is_empty() {
        let row = gtk::ListBoxRow::new();
        row.set_activatable(false);
        row.set_selectable(false);
        row.add(&build_empty_state(
            "application-x-addon-symbolic",
            "No extensions installed",
            "Click '+ Load Unpacked' to load an unpacked Chrome extension folder with manifest.json.",
        ));
        list.add(&row);
        list.show_all();
        return;
    }

    for ext in extensions {
        let row = gtk::ListBoxRow::new();
        row.set_activatable(false);
        row.set_selectable(false);

        let card = gtk::Box::new(gtk::Orientation::Vertical, 6);
        card.style_context().add_class("forkit-panel-card");

        let header = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        let name_lbl = gtk::Label::new(Some(&format!(
            "{}  v{} (MV{})",
            ext.name, ext.version, ext.manifest_version
        )));
        name_lbl.style_context().add_class("forkit-panel-item-title");
        name_lbl.set_xalign(0.0);
        name_lbl.set_ellipsize(gtk::pango::EllipsizeMode::End);
        name_lbl.set_hexpand(true);

        let sw = gtk::Switch::new();
        sw.set_active(ext.enabled);
        let app_sw = app.clone();
        let ext_id_sw = ext.id.clone();
        sw.connect_state_set(move |_, active| {
            if let Some(st) = app_sw.try_state::<crate::extensions::ExtensionManagerState>() {
                let _ = st.inner.lock().unwrap().set_enabled(&ext_id_sw, active);
            }
            apply_extensions_to_open_tabs(&app_sw, Some((&ext_id_sw, active)));
            gtk::glib::Propagation::Proceed
        });

        header.pack_start(&name_lbl, true, true, 0);
        header.pack_end(&sw, false, false, 0);
        card.pack_start(&header, false, false, 0);

        if !ext.description.is_empty() {
            let desc = gtk::Label::new(Some(&ext.description));
            desc.style_context().add_class("forkit-panel-muted");
            desc.set_xalign(0.0);
            desc.set_line_wrap(true);
            desc.set_max_width_chars(44);
            card.pack_start(&desc, false, false, 0);
        }

        let actions = gtk::Box::new(gtk::Orientation::Horizontal, 6);

        if let Some(popup_rel) = ext.popup.clone() {
            let popup_btn = gtk::Button::with_label("Open Popup");
            popup_btn.style_context().add_class("forkit-panel-btn");
            let app_pop = app.clone();
            let ext_id_pop = ext.id.clone();
            let ext_name_pop = ext.name.clone();
            popup_btn.connect_clicked(move |_| {
                open_extension_popup_window(&app_pop, &ext_id_pop, &ext_name_pop, &popup_rel);
            });
            actions.pack_start(&popup_btn, false, false, 0);
        }

        let reload_btn = gtk::Button::with_label("Reload");
        reload_btn.style_context().add_class("forkit-panel-btn");
        let app_rel = app.clone();
        let ext_id_rel = ext.id.clone();
        let list_rel = list.clone();
        let status_rel = status_lbl.clone();
        reload_btn.connect_clicked(move |_| {
            if let Some(st) = app_rel.try_state::<crate::extensions::ExtensionManagerState>() {
                match st.inner.lock().unwrap().reload_extension(&ext_id_rel) {
                    Ok(reloaded) => {
                        status_rel.set_text(&format!("Reloaded '{}'", reloaded.name));
                        status_rel.show();
                        apply_extensions_to_open_tabs(&app_rel, Some((&ext_id_rel, reloaded.enabled)));
                    }
                    Err(e) => {
                        status_rel.set_text(&format!("Reload error: {}", e));
                        status_rel.show();
                    }
                }
            }
            populate_extensions_list(&app_rel, &list_rel, &status_rel);
        });

        let remove_btn = gtk::Button::with_label("Remove");
        remove_btn.style_context().add_class("forkit-panel-btn");
        let app_rem = app.clone();
        let ext_id_rem = ext.id.clone();
        let list_rem = list.clone();
        let status_rem = status_lbl.clone();
        remove_btn.connect_clicked(move |_| {
            if let Some(st) = app_rem.try_state::<crate::extensions::ExtensionManagerState>() {
                let _ = st.inner.lock().unwrap().remove_extension(&ext_id_rem);
            }
            apply_extensions_to_open_tabs(&app_rem, Some((&ext_id_rem, false)));
            populate_extensions_list(&app_rem, &list_rem, &status_rem);
        });

        actions.pack_start(&reload_btn, false, false, 0);
        actions.pack_end(&remove_btn, false, false, 0);
        card.pack_start(&actions, false, false, 0);

        row.add(&card);
        list.add(&row);
    }
    list.show_all();
}

fn apply_extensions_to_open_tabs(app: &AppHandle, toggle: Option<(&str, bool)>) {
    if let Some((ext_id, enabled)) = toggle {
        let id_json = serde_json::to_string(ext_id).unwrap_or_else(|_| "\"\"".to_string());
        let disabled_val = if enabled { "false" } else { "true" };
        let js = format!(
            "window.__forkitExtDisabled = window.__forkitExtDisabled || {{}}; window.__forkitExtDisabled[{id_json}] = {disabled_val};"
        );
        if let Some(ui_st) = app.try_state::<NativeUiState>() {
            let tab_ids: Vec<u64> = ui_st.tabs.lock().unwrap().iter().map(|t| t.tab_id).collect();
            for tid in tab_ids {
                if let Some(wv) = app.get_webview(&format!("tab-{}", tid)) {
                    let _ = wv.eval(&js);
                    let _ = wv.with_webview({
                        let app_c = app.clone();
                        move |platform_wv| {
                            let wk = platform_wv.inner();
                            if enabled {
                                crate::extensions::install_extensions_on_webkit(&app_c, &wk);
                            }
                        }
                    });
                }
            }
            if let Some(active_id) = *ui_st.active_tab_id.lock().unwrap() {
                let _ = reload_tab(app.clone(), active_id);
            }
        }
    }
}

fn open_extension_popup_window(app: &AppHandle, ext_id: &str, ext_name: &str, popup_rel: &str) {
    use webkit2gtk::{
        SecurityManagerExt, URISchemeRequestExt, UserContentManager, UserContentManagerExt,
        WebContext, WebContextExt, WebViewExt,
    };

    let root = gtk::Box::new(gtk::Orientation::Vertical, 8);
    root.style_context().add_class("forkit-panel-box");

    let top_row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let back_btn = gtk::Button::from_icon_name(Some("go-previous-symbolic"), gtk::IconSize::Menu);
    back_btn.style_context().add_class("forkit-panel-icon-btn");
    back_btn.set_tooltip_text(Some("Back to Extensions"));
    let app_bk = app.clone();
    back_btn.connect_clicked(move |_| {
        open_native_panel(&app_bk, "extensions");
    });

    let title = gtk::Label::new(Some(ext_name));
    title.style_context().add_class("forkit-panel-title");
    title.set_xalign(0.0);
    title.set_ellipsize(gtk::pango::EllipsizeMode::End);
    title.set_hexpand(true);

    let close_btn = gtk::Button::from_icon_name(
        Some("window-close-symbolic"),
        gtk::IconSize::Menu,
    );
    close_btn.style_context().add_class("forkit-panel-icon-btn");
    close_btn.set_tooltip_text(Some("Close"));
    let app_cl = app.clone();
    close_btn.connect_clicked(move |_| close_active_panel_overlay(&app_cl));

    top_row.pack_start(&back_btn, false, false, 0);
    top_row.pack_start(&title, true, true, 0);
    top_row.pack_end(&close_btn, false, false, 0);
    root.pack_start(&top_row, false, false, 0);

    let ctx = WebContext::new();
    if let Some(sec) = ctx.security_manager() {
        sec.register_uri_scheme_as_secure("chrome-extension");
        sec.register_uri_scheme_as_cors_enabled("chrome-extension");
    }

    let app_scheme = app.clone();
    ctx.register_uri_scheme("chrome-extension", move |req| {
        let uri_str = req.uri().map(|s| s.to_string()).unwrap_or_default();
        let Ok(parsed) = url::Url::parse(&uri_str) else {
            return;
        };
        let req_ext_id = parsed.host_str().unwrap_or("");
        let req_path = parsed.path().trim_start_matches('/');

        if let Some(st) = app_scheme.try_state::<crate::extensions::ExtensionManagerState>() {
            let mgr = st.inner.lock().unwrap();
            if let Some((bytes, mime)) = mgr.resolve_asset(req_ext_id, req_path) {
                let mime_clean = mime.split(';').next().unwrap_or(mime).trim();
                let final_bytes = if mime_clean == "text/html" {
                    if let Some(ext) = mgr.extensions.iter().find(|e| e.id == req_ext_id) {
                        let active_tab = crate::gtk_ui::get_active_tab_info(&app_scheme);
                        let shim = format!(
                            "<style>html,body{{width:100%!important;max-width:100%!important;box-sizing:border-box;}}</style><script>{}</script>",
                            crate::extensions::build_chrome_api_shim(
                                ext,
                                true,
                                Some((active_tab.0, &active_tab.1, &active_tab.2))
                            )
                        );
                        let html = String::from_utf8_lossy(&bytes);
                        if let Some(pos) = html.to_ascii_lowercase().find("<head>") {
                            let mut out = String::with_capacity(html.len() + shim.len());
                            out.push_str(&html[..pos + 6]);
                            out.push_str(&shim);
                            out.push_str(&html[pos + 6..]);
                            out.into_bytes()
                        } else {
                            format!("{shim}{html}").into_bytes()
                        }
                    } else {
                        bytes
                    }
                } else {
                    bytes
                };

                let gbytes = webkit2gtk::glib::Bytes::from(&final_bytes);
                let stream = webkit2gtk::gio::MemoryInputStream::from_bytes(&gbytes);
                req.finish(&stream, final_bytes.len() as i64, Some(mime_clean));
                return;
            }
        }
        let empty = webkit2gtk::glib::Bytes::from(b"Not Found".as_slice());
        let stream = webkit2gtk::gio::MemoryInputStream::from_bytes(&empty);
        req.finish(&stream, 9, Some("text/plain"));
    });

    let ucm = UserContentManager::new();
    let wk = webkit2gtk::WebView::builder()
        .web_context(&ctx)
        .user_content_manager(&ucm)
        .build();
    wk.set_size_request(332, 420);
    wk.set_vexpand(true);
    wk.set_hexpand(true);

    // Wire storage message handler for the popup WebView
    if ucm.register_script_message_handler("forkitExt") {
        let app_msg = app.clone();
        let wk_weak = webkit2gtk::glib::object::ObjectExt::downgrade(&wk);
        ucm.connect_script_message_received(None, move |_ucm, js_res| {
            let Some(val) = js_res.js_value() else { return; };
            let raw = val.to_string();
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw.as_str()) else { return; };
            if parsed.get("type").and_then(|v| v.as_str()) != Some("storage") {
                return;
            }
            let msg_ext_id = parsed.get("extId").and_then(|v| v.as_str()).unwrap_or("");
            let req_id = parsed.get("reqId").and_then(|v| v.as_str()).unwrap_or("");
            let action = parsed.get("action").and_then(|v| v.as_str()).unwrap_or("");
            let payload = parsed.get("payload").cloned().unwrap_or(serde_json::Value::Null);
            let result = if let Some(st) = app_msg.try_state::<crate::extensions::ExtensionManagerState>() {
                st.inner.lock().unwrap().storage_op(msg_ext_id, action, payload)
            } else {
                serde_json::json!({})
            };
            if let Some(wk_strong) = wk_weak.upgrade() {
                let req_json = serde_json::to_string(req_id).unwrap_or_else(|_| "\"\"".to_string());
                let res_json = serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string());
                let js = format!("window.__forkitExtReply && window.__forkitExtReply({req_json}, {res_json});");
                wk_strong.evaluate_javascript(&js, None, None, webkit2gtk::gio::Cancellable::NONE, |_| {});
            }
        });
    }

    let clean_rel = popup_rel.trim_start_matches('/');
    let url_str = format!("chrome-extension://{}/{}", ext_id, clean_rel);
    wk.load_uri(&url_str);

    root.pack_start(&wk, true, true, 0);
    show_in_app_overlay(app, "ext-popup", &root, OverlayPlacement::TopRight(360, 490));
}
