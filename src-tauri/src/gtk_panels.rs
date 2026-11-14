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
    let file_opt = st.history_file.lock().unwrap().clone();
    if let Some(path) = file_opt {
        let data = st.history.lock().unwrap().clone();
        if let Ok(json) = serde_json::to_string(&data) {
            let _ = std::fs::write(path, json);
        }
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
        } else {
            dls.push(DownloadEntry {
                file_name: file_name.to_string(),
                progress,
                downloaded,
                total_size,
                status: "Downloading".to_string(),
                path: String::new(),
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
            });
        }
    }
    schedule_downloads_refresh(app, true);
}

fn ensure_panel_css() {
    thread_local! {
        static PANEL_CSS_INIT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }
    PANEL_CSS_INIT.with(|init| {
        if init.get() {
            return;
        }
        init.set(true);
        let css = gtk::CssProvider::new();
        let _ = css.load_from_data(
            b"
            .forkit-panel-backdrop {
                background-color: rgba(0, 0, 0, 0.55);
            }
            .forkit-panel-box {
                background-color: #181820;
                color: #eceef4;
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 14px;
                padding: 18px;
            }
            .forkit-panel-popover {
                background-color: #181820;
                color: #eceef4;
                border: 1px solid rgba(255,255,255,0.14);
                border-radius: 14px;
                padding: 16px;
            }
            .forkit-panel-full {
                background-color: #111115;
                color: #eceef4;
                border: none;
                border-radius: 0;
                padding: 24px 36px;
            }
            .forkit-panel-title {
                font-size: 16px;
                font-weight: bold;
                color: #ffffff;
            }
            .forkit-panel-title-lg {
                font-size: 20px;
                font-weight: bold;
                color: #ffffff;
            }
            .forkit-panel-muted {
                font-size: 12px;
                color: #9499a6;
            }
            .forkit-panel-sub {
                font-size: 11px;
                color: #7c8292;
            }
            .forkit-panel-item-title {
                font-size: 13px;
                font-weight: 600;
                color: #f3f4f8;
            }
            .forkit-panel-card {
                background-color: #20202a;
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 10px;
                padding: 12px;
            }
            .forkit-panel-dl-card {
                background-color: #20202a;
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 10px;
                padding: 10px 12px;
            }
            .forkit-panel-icon-badge {
                background-color: rgba(102, 126, 234, 0.16);
                color: #9bb4ff;
                border-radius: 8px;
                padding: 7px;
            }
            .forkit-panel-search {
                background-color: #1b1b24;
                color: #eceef4;
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 999px;
                padding: 6px 14px;
                min-height: 22px;
            }
            .forkit-panel-search:focus {
                border-color: #667eea;
            }
            .forkit-panel-btn {
                background-color: #262632;
                color: #eceef4;
                border: 1px solid rgba(255,255,255,0.1);
                border-radius: 8px;
                padding: 6px 12px;
                box-shadow: none;
            }
            .forkit-panel-btn:hover {
                background-color: #343444;
            }
            .forkit-panel-btn-danger {
                background-color: rgba(248, 113, 113, 0.14);
                color: #fca5a5;
                border: 1px solid rgba(248, 113, 113, 0.25);
                border-radius: 8px;
                padding: 6px 12px;
                box-shadow: none;
            }
            .forkit-panel-btn-danger:hover {
                background-color: rgba(248, 113, 113, 0.24);
            }
            .forkit-panel-icon-btn {
                background-color: transparent;
                color: #9499a6;
                border: none;
                border-radius: 8px;
                padding: 5px 8px;
                box-shadow: none;
            }
            .forkit-panel-icon-btn:hover {
                background-color: rgba(255,255,255,0.08);
                color: #ffffff;
            }
            .forkit-panel-primary {
                background-image: linear-gradient(135deg, #667eea, #764ba2);
                color: #ffffff;
                border: none;
                border-radius: 8px;
                padding: 6px 14px;
                box-shadow: none;
            }
            .forkit-badge-dl {
                background-color: rgba(138, 180, 248, 0.16);
                color: #8ab4f8;
                border-radius: 999px;
                padding: 2px 8px;
                font-size: 11px;
                font-weight: 600;
            }
            .forkit-badge-ok {
                background-color: rgba(74, 222, 128, 0.16);
                color: #4ade80;
                border-radius: 999px;
                padding: 2px 8px;
                font-size: 11px;
                font-weight: 600;
            }
            .forkit-badge-err {
                background-color: rgba(248, 113, 113, 0.16);
                color: #f87171;
                border-radius: 999px;
                padding: 2px 8px;
                font-size: 11px;
                font-weight: 600;
            }
            progressbar.forkit-dl-bar trough {
                background-color: #14141a;
                border-radius: 999px;
                min-height: 6px;
                border: none;
            }
            progressbar.forkit-dl-bar progress {
                background-image: linear-gradient(90deg, #667eea, #764ba2);
                border-radius: 999px;
                min-height: 6px;
                border: none;
            }
            .forkit-hist-container {
                background-color: #181820;
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 14px;
                padding: 6px;
            }
            list.forkit-panel-list {
                background-color: transparent;
                border-radius: 10px;
            }
            list.forkit-panel-list row {
                padding: 10px 12px;
                border-radius: 8px;
                border-bottom: 1px solid rgba(255,255,255,0.04);
                margin-bottom: 2px;
            }
            list.forkit-panel-list row:hover {
                background-color: rgba(102, 126, 234, 0.14);
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
            ",
        );
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
    ensure_panel_css();
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
            _ => {}
        }
    });
}

fn open_dpi_window(app: &AppHandle) {
    let root = gtk::Box::new(gtk::Orientation::Vertical, 12);
    root.style_context().add_class("forkit-panel-box");

    let header = gtk::Label::new(Some("Forkit Shield — Ad Blocker"));
    header.style_context().add_class("forkit-panel-title");
    header.set_xalign(0.0);
    root.pack_start(&header, false, false, 0);

    let (enabled, blocked_total) = app
        .try_state::<AdBlockerState>()
        .and_then(|s| s.inner.lock().ok().map(|b| (b.is_enabled, b.stats.blocked)))
        .unwrap_or((true, 0));

    let toggle_card = gtk::Box::new(gtk::Orientation::Horizontal, 12);
    toggle_card.style_context().add_class("forkit-panel-card");
    let toggle_lbl = gtk::Label::new(Some("Ad & Tracker Blocker"));
    toggle_lbl.set_xalign(0.0);
    let sw = gtk::Switch::new();
    sw.set_active(enabled);
    let app_sw = app.clone();
    sw.connect_state_set(move |_, active| {
        if let Some(ad_state) = app_sw.try_state::<AdBlockerState>() {
            if let Ok(mut blocker) = ad_state.inner.lock() {
                blocker.is_enabled = active;
            }
        }
        if let Some(ui_st) = app_sw.try_state::<NativeUiState>() {
            if let Some(id) = *ui_st.active_tab_id.lock().unwrap() {
                let _ = reload_tab(app_sw.clone(), id);
            }
        }
        gtk::glib::Propagation::Proceed
    });
    toggle_card.pack_start(&toggle_lbl, true, true, 0);
    toggle_card.pack_end(&sw, false, false, 0);
    root.pack_start(&toggle_card, false, false, 0);

    let stats_card = gtk::Box::new(gtk::Orientation::Horizontal, 12);
    stats_card.style_context().add_class("forkit-panel-card");
    let stats_lbl = gtk::Label::new(Some(&format!("Blocked requests: {}", blocked_total)));
    stats_lbl.set_xalign(0.0);
    let reset_btn = gtk::Button::with_label("Reset Stats");
    reset_btn.style_context().add_class("forkit-panel-btn");
    let app_rst = app.clone();
    let stats_lbl_rst = stats_lbl.clone();
    reset_btn.connect_clicked(move |_| {
        if let Some(ad_state) = app_rst.try_state::<AdBlockerState>() {
            if let Ok(mut blocker) = ad_state.inner.lock() {
                blocker.stats.blocked = 0;
                blocker.stats.allowed = 0;
            }
        }
        stats_lbl_rst.set_text("Blocked requests: 0");
    });
    stats_card.pack_start(&stats_lbl, true, true, 0);
    stats_card.pack_end(&reset_btn, false, false, 0);
    root.pack_start(&stats_card, false, false, 0);

    let filter_card = gtk::Box::new(gtk::Orientation::Vertical, 8);
    filter_card.style_context().add_class("forkit-panel-card");
    let filter_lbl = gtk::Label::new(Some("Add Custom Filter Pattern"));
    filter_lbl.set_xalign(0.0);
    let filter_row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let filter_entry = gtk::Entry::new();
    filter_entry.style_context().add_class("forkit-address");
    filter_entry.set_placeholder_text(Some("e.g. ads.example.com"));
    filter_entry.set_hexpand(true);
    let add_filter_btn = gtk::Button::with_label("Add");
    add_filter_btn.style_context().add_class("forkit-panel-primary");
    let app_flt = app.clone();
    let entry_flt = filter_entry.clone();
    add_filter_btn.connect_clicked(move |_| {
        let pat = entry_flt.text().trim().to_string();
        if !pat.is_empty() {
            if let Some(ad_state) = app_flt.try_state::<AdBlockerState>() {
                if let Ok(mut blocker) = ad_state.inner.lock() {
                    blocker.block_patterns.push(pat);
                }
            }
            entry_flt.set_text("");
        }
    });
    filter_row.pack_start(&filter_entry, true, true, 0);
    filter_row.pack_end(&add_filter_btn, false, false, 0);
    filter_card.pack_start(&filter_lbl, false, false, 0);
    filter_card.pack_start(&filter_row, false, false, 0);
    root.pack_start(&filter_card, false, false, 0);

    let close_row = gtk::Box::new(gtk::Orientation::Horizontal, 8);
    let close_btn = gtk::Button::with_label("Close");
    close_btn.style_context().add_class("forkit-panel-btn");
    let app_cl = app.clone();
    close_btn.connect_clicked(move |_| close_active_panel_overlay(&app_cl));
    close_row.pack_end(&close_btn, false, false, 0);
    root.pack_end(&close_row, false, false, 0);

    show_in_app_overlay(app, "dpi", &root, OverlayPlacement::Centered(460, 360));
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

    let icon = gtk::Image::from_icon_name(Some(icon_name), gtk::IconSize::Dialog);
    icon.style_context().add_class("forkit-panel-muted");
    let title = gtk::Label::new(Some(title_text));
    title.style_context().add_class("forkit-panel-item-title");
    let sub = gtk::Label::new(Some(sub_text));
    sub.style_context().add_class("forkit-panel-muted");

    box_.pack_start(&icon, false, false, 0);
    box_.pack_start(&title, false, false, 0);
    box_.pack_start(&sub, false, false, 0);
    box_
}

fn open_history_window(app: &AppHandle) {
    let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
    root.style_context().add_class("forkit-panel-full");

    let center_wrap = gtk::Box::new(gtk::Orientation::Vertical, 16);
    center_wrap.set_halign(gtk::Align::Center);
    center_wrap.set_size_request(860, -1);
    center_wrap.set_vexpand(true);

    let top_row = gtk::Box::new(gtk::Orientation::Horizontal, 12);
    let title_box = gtk::Box::new(gtk::Orientation::Horizontal, 10);
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
    search.set_placeholder_text(Some("Search history..."));
    search.set_hexpand(true);
    search.set_size_request(320, -1);

    let clear_btn = gtk::Button::with_label("Clear History");
    clear_btn.style_context().add_class("forkit-panel-btn-danger");
    let close_btn = gtk::Button::from_icon_name(
        Some("window-close-symbolic"),
        gtk::IconSize::Menu,
    );
    close_btn.style_context().add_class("forkit-panel-icon-btn");
    close_btn.set_tooltip_text(Some("Close"));
    let app_cl_h = app.clone();
    close_btn.connect_clicked(move |_| close_active_panel_overlay(&app_cl_h));

    top_row.pack_start(&title_box, false, false, 0);
    top_row.pack_start(&search, true, true, 16);
    top_row.pack_end(&close_btn, false, false, 0);
    top_row.pack_end(&clear_btn, false, false, 0);
    center_wrap.pack_start(&top_row, false, false, 0);

    let card_frame = gtk::Box::new(gtk::Orientation::Vertical, 0);
    card_frame.style_context().add_class("forkit-hist-container");
    card_frame.set_vexpand(true);

    let scroll = gtk::ScrolledWindow::new(None::<&gtk::Adjustment>, None::<&gtk::Adjustment>);
    scroll.set_vexpand(true);
    let list = gtk::ListBox::new();
    list.style_context().add_class("forkit-panel-list");
    list.set_selection_mode(gtk::SelectionMode::None);
    scroll.add(&list);
    card_frame.pack_start(&scroll, true, true, 0);
    center_wrap.pack_start(&card_frame, true, true, 0);
    root.pack_start(&center_wrap, true, true, 0);

    let populate = {
        let app_p = app.clone();
        let list_p = list.clone();
        move |query: &str| {
            for ch in list_p.children() {
                list_p.remove(&ch);
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
            for item in entries {
                if !q.is_empty()
                    && !item.title.to_lowercase().contains(&q)
                    && !item.url.to_lowercase().contains(&q)
                {
                    continue;
                }
                count += 1;
                let row = gtk::ListBoxRow::new();
                let hbox = gtk::Box::new(gtk::Orientation::Horizontal, 12);

                let badge = gtk::Box::new(gtk::Orientation::Horizontal, 0);
                badge.style_context().add_class("forkit-panel-icon-badge");
                badge.set_valign(gtk::Align::Center);
                let globe = gtk::Image::from_icon_name(
                    Some("applications-internet-symbolic"),
                    gtk::IconSize::Menu,
                );
                badge.add(&globe);

                let vbox = gtk::Box::new(gtk::Orientation::Vertical, 2);
                vbox.set_hexpand(true);
                let t = gtk::Label::new(Some(&item.title));
                t.style_context().add_class("forkit-panel-item-title");
                t.set_xalign(0.0);
                t.set_ellipsize(gtk::pango::EllipsizeMode::End);

                let u = gtk::Label::new(Some(&item.url));
                u.style_context().add_class("forkit-panel-muted");
                u.set_xalign(0.0);
                u.set_ellipsize(gtk::pango::EllipsizeMode::End);

                vbox.pack_start(&t, false, false, 0);
                vbox.pack_start(&u, false, false, 0);

                let rel = format_relative_time(item.timestamp, now);
                let time_lbl = gtk::Label::new(Some(&rel));
                time_lbl.style_context().add_class("forkit-panel-sub");
                time_lbl.set_valign(gtk::Align::Center);

                hbox.pack_start(&badge, false, false, 0);
                hbox.pack_start(&vbox, true, true, 0);
                hbox.pack_end(&time_lbl, false, false, 0);

                row.add(&hbox);
                unsafe {
                    row.set_data("forkit_hist_url", item.url);
                }
                list_p.add(&row);
            }
            if count == 0 {
                let row = gtk::ListBoxRow::new();
                row.set_activatable(false);
                row.set_selectable(false);
                let msg = if q.is_empty() {
                    "Pages you visit will appear here"
                } else {
                    "No matching history entries"
                };
                row.add(&build_empty_state(
                    "document-open-recent-symbolic",
                    "No history found",
                    msg,
                ));
                list_p.add(&row);
            }
            list_p.show_all();
        }
    };

    populate("");

    let pop_search = populate.clone();
    search.connect_search_changed(move |s| {
        pop_search(&s.text());
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

    let app_act = app.clone();
    list.connect_row_activated(move |_, row| {
        let url_opt = unsafe { row.data::<String>("forkit_hist_url").map(|p| p.as_ref().clone()) };
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

        header.pack_start(&file_icon, false, false, 0);
        header.pack_start(&name, true, true, 0);
        header.pack_end(&badge, false, false, 0);
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
