use gtk::prelude::*;
use std::cell::RefCell;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::adblocker::AdBlockerState;
use crate::downloads::download_item;
use crate::tabs::{
    claim_spare_newtab, close_tab_webview_inner, create_tab_webview_hidden,
    create_tab_webview_inner, go_back_tab, go_forward_tab, navigate_tab, open_overlay_panel_inner,
    reload_tab, switch_tab_webview_inner, TabBounds, TabManagerState,
};

#[derive(Clone, Debug)]
pub struct NativeTabInfo {
    pub tab_id: u64,
    pub title: String,
    pub url: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

pub struct NativeUiState {
    pub tabs: Mutex<Vec<NativeTabInfo>>,
    pub next_tab_id: Mutex<u64>,
    pub active_tab_id: Mutex<Option<u64>>,
    pub base_app_url: Mutex<Option<String>>,
}

impl Default for NativeUiState {
    fn default() -> Self {
        Self {
            tabs: Mutex::new(Vec::new()),
            next_tab_id: Mutex::new(0),
            active_tab_id: Mutex::new(None),
            base_app_url: Mutex::new(None),
        }
    }
}

struct GtkTopBarWidgets {
    tabs_container: gtk::Fixed,
    address_entry: gtk::Entry,
    back_btn: gtk::Button,
    forward_btn: gtk::Button,
    adblock_btn: gtk::Button,
}

struct TabDragState {
    tab_id: u64,
    start_root_x: f64,
    last_root_x: f64,
    did_drag: bool,
}

struct TabAnimItem {
    tab_id: u64,
    widget: gtk::EventBox,
    current_x: f64,
    target_x: f64,
    width: i32,
}

#[derive(Default)]
struct TabAnimState {
    items: Vec<TabAnimItem>,
    timer_active: bool,
}

thread_local! {
    static TOP_BAR_WIDGETS: RefCell<Option<GtkTopBarWidgets>> = const { RefCell::new(None) };
    static TAB_DRAG_STATE: RefCell<Option<TabDragState>> = const { RefCell::new(None) };
    static TAB_ANIM_STATE: RefCell<TabAnimState> = RefCell::new(TabAnimState::default());
    static TAB_FAVICONS: RefCell<std::collections::HashMap<u64, gtk::gdk_pixbuf::Pixbuf>> = RefCell::new(std::collections::HashMap::new());
}

fn update_tab_targets(tabs_order: &[NativeTabInfo]) {
    TAB_ANIM_STATE.with(|a| {
        let mut anim = a.borrow_mut();
        let mut x = 0.0;
        for t in tabs_order {
            if let Some(item) = anim.items.iter_mut().find(|it| it.tab_id == t.tab_id) {
                item.target_x = x;
                x += item.width as f64 + 4.0;
            }
        }
    });
}

fn ensure_tab_anim_timer(container: &gtk::Fixed) {
    let already_active = TAB_ANIM_STATE.with(|a| {
        let mut anim = a.borrow_mut();
        if anim.timer_active {
            true
        } else {
            anim.timer_active = true;
            false
        }
    });
    if already_active {
        return;
    }

    let container_timer = container.clone();
    gtk::glib::timeout_add_local(std::time::Duration::from_millis(16), move || {
        let active_drag_id =
            TAB_DRAG_STATE.with(|d| d.borrow().as_ref().filter(|s| s.did_drag).map(|s| s.tab_id));

        let keep_running = TAB_ANIM_STATE.with(|a| {
            let mut anim = a.borrow_mut();
            let mut any_moving = false;
            for item in &mut anim.items {
                if Some(item.tab_id) == active_drag_id {
                    continue;
                }
                let diff = item.target_x - item.current_x;
                if diff.abs() < 0.5 {
                    if (item.current_x - item.target_x).abs() > 0.01 {
                        item.current_x = item.target_x;
                        container_timer.move_(&item.widget, item.current_x.round() as i32, 0);
                    }
                } else {
                    item.current_x += diff * 0.28;
                    container_timer.move_(&item.widget, item.current_x.round() as i32, 0);
                    any_moving = true;
                }
            }
            if !any_moving && active_drag_id.is_none() {
                anim.timer_active = false;
                false
            } else {
                true
            }
        });

        if keep_running {
            gtk::glib::ControlFlow::Continue
        } else {
            gtk::glib::ControlFlow::Break
        }
    });
}

fn default_bounds(app: &AppHandle) -> TabBounds {
    let (w, h) = app
        .try_state::<TabManagerState>()
        .map(|s| *s.window_size.lock().unwrap())
        .unwrap_or((1400.0, 800.0));
    TabBounds {
        x: 0.0,
        y: 104.0,
        width: w,
        height: (h - 104.0).max(100.0),
    }
}

fn normalize_input_url(raw: &str) -> Option<String> {
    let input = raw.trim();
    if input.is_empty() {
        return None;
    }
    if input.starts_with("http://")
        || input.starts_with("https://")
        || input.starts_with("file://")
    {
        return Some(input.to_string());
    }
    if !input.contains(' ') && (input.contains('.') || input.starts_with("localhost")) {
        return Some(format!("https://{}", input));
    }
    let encoded = url::form_urlencoded::byte_serialize(input.as_bytes()).collect::<String>();
    Some(format!("https://www.google.com/search?q={}", encoded))
}

pub(crate) fn is_system_dark(win: Option<&tauri::Window>) -> bool {
    if let Some(w) = win {
        if let Ok(theme) = w.theme() {
            return matches!(theme, tauri::Theme::Dark);
        }
    }
    if let Some(settings) = gtk::Settings::default() {
        if settings.is_gtk_application_prefer_dark_theme() {
            return true;
        }
        if let Some(name) = settings.gtk_theme_name() {
            if name.to_lowercase().contains("dark") {
                return true;
            }
        }
    }
    false
}

pub fn init_native_top_bar(app: &AppHandle) {
    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(main_win) = app_clone.get_window("main") else {
            return;
        };
        if let Ok(gtk_win) = main_win.gtk_window() {
            let loader = gtk::gdk_pixbuf::PixbufLoader::new();
            if loader.write(include_bytes!("../../build/icon.png")).is_ok()
                && loader.close().is_ok()
            {
                if let Some(pixbuf) = loader.pixbuf() {
                    gtk::Window::set_default_icon(&pixbuf);
                    gtk_win.set_icon(Some(&pixbuf));
                }
            }
        }
        let Ok(vbox) = main_win.default_vbox() else {
            return;
        };

        let dark = is_system_dark(Some(&main_win));
        let css = gtk::CssProvider::new();
        let css_bytes: &[u8] = if dark {
            b"
            .forkit-topbar {
                background-color: #0c0c0f;
                color: #f0eff4;
            }
            .forkit-tabs-row {
                background-color: #0c0c0f;
                padding: 8px 10px 0 10px;
            }
            .forkit-tab-btn {
                background-color: transparent;
                color: #8e8d9a;
                border: 1px solid transparent;
                border-bottom: none;
                border-radius: 6px 6px 0 0;
                padding: 4px 10px;
                min-height: 32px;
                min-width: 140px;
                font-size: 12.5px;
                box-shadow: none;
            }
            .forkit-tab-btn:hover {
                background-color: rgba(255, 255, 255, 0.05);
                color: #f0eff4;
            }
            .forkit-tab-btn.active {
                background-color: #16161b;
                color: #f0eff4;
                border-color: #272730;
                border-top: 2px solid #a78bfa;
            }
            .forkit-tab-label {
                padding: 0 4px;
                background: transparent;
                border: none;
                box-shadow: none;
                color: inherit;
            }
            .forkit-tab-close {
                background: transparent;
                border: none;
                color: #8e8d9a;
                padding: 2px;
                min-width: 20px;
                min-height: 20px;
                border-radius: 5px;
                box-shadow: none;
            }
            .forkit-tab-close:hover {
                color: #f0eff4;
                background-color: rgba(255, 255, 255, 0.10);
            }
            .forkit-icon-btn {
                background: transparent;
                border: none;
                color: #f0eff4;
                border-radius: 8px;
                padding: 0;
                min-width: 34px;
                min-height: 34px;
                box-shadow: none;
            }
            .forkit-icon-btn:hover {
                background-color: #1e1e25;
                color: #c4b5fd;
            }
            .forkit-icon-btn:disabled {
                color: rgba(240, 239, 244, 0.28);
            }
            .forkit-win-btn {
                background: transparent;
                border: none;
                color: #8e8d9a;
                border-radius: 6px;
                padding: 0;
                min-width: 34px;
                min-height: 30px;
                box-shadow: none;
            }
            .forkit-win-btn:hover {
                background-color: #1e1e25;
                color: #f0eff4;
            }
            .forkit-win-close:hover {
                background-color: #e11d48;
                color: #ffffff;
            }
            .forkit-toolbar {
                background-color: #16161b;
                border-bottom: 1px solid #272730;
                padding: 8px 12px;
            }
            .forkit-address {
                background-color: #101014;
                color: #f0eff4;
                border: 1px solid #272730;
                border-radius: 8px;
                padding: 0 14px;
                min-height: 34px;
                font-size: 13px;
                caret-color: #a78bfa;
                box-shadow: none;
            }
            .forkit-address:focus {
                border-color: #a78bfa;
                background-color: #131318;
            }
            .forkit-adblock {
                background-image: none;
                background-color: #a78bfa;
                color: #0c0c0f;
                border-radius: 8px;
                min-width: 36px;
                min-height: 36px;
                padding: 0;
                border: 1px solid #a78bfa;
                box-shadow: none;
            }
            .forkit-adblock:hover {
                background-color: #c4b5fd;
                border-color: #c4b5fd;
            }
            .forkit-adblock.disabled {
                background-image: none;
                background-color: #1e1e25;
                color: #8e8d9a;
                border-color: #272730;
            }
            menu.forkit-tab-ctx {
                background-color: #16161b;
                color: #f0eff4;
                border: 1px solid #272730;
                border-radius: 8px;
                padding: 6px;
                box-shadow: none;
            }
            menu.forkit-tab-ctx menuitem {
                padding: 6px 12px;
                border-radius: 6px;
            }
            menu.forkit-tab-ctx menuitem:hover {
                background-color: rgba(167, 139, 250, 0.16);
            }
            "
        } else {
            b"
            .forkit-topbar {
                background-color: #ebe6f7;
                color: #1e1633;
            }
            .forkit-tabs-row {
                background-color: #ebe6f7;
                padding: 8px 10px 0 10px;
            }
            .forkit-tab-btn {
                background-color: transparent;
                color: #6b5f84;
                border: 1px solid transparent;
                border-bottom: none;
                border-radius: 6px 6px 0 0;
                padding: 4px 10px;
                min-height: 32px;
                min-width: 140px;
                font-size: 12.5px;
                box-shadow: none;
            }
            .forkit-tab-btn:hover {
                background-color: rgba(124, 58, 237, 0.08);
                color: #1e1633;
            }
            .forkit-tab-btn.active {
                background-color: #ffffff;
                color: #1e1633;
                border-color: #dcd3f2;
                border-top: 2px solid #8b5cf6;
            }
            .forkit-tab-label {
                padding: 0 4px;
                background: transparent;
                border: none;
                box-shadow: none;
                color: inherit;
            }
            .forkit-tab-close {
                background: transparent;
                border: none;
                color: #6b5f84;
                padding: 2px;
                min-width: 20px;
                min-height: 20px;
                border-radius: 5px;
                box-shadow: none;
            }
            .forkit-tab-close:hover {
                color: #1e1633;
                background-color: rgba(124, 58, 237, 0.12);
            }
            .forkit-icon-btn {
                background: transparent;
                border: none;
                color: #1e1633;
                border-radius: 8px;
                padding: 0;
                min-width: 34px;
                min-height: 34px;
                box-shadow: none;
            }
            .forkit-icon-btn:hover {
                background-color: #f0ebf9;
                color: #7c3aed;
            }
            .forkit-icon-btn:disabled {
                color: rgba(30, 22, 51, 0.28);
            }
            .forkit-win-btn {
                background: transparent;
                border: none;
                color: #6b5f84;
                border-radius: 6px;
                padding: 0;
                min-width: 34px;
                min-height: 30px;
                box-shadow: none;
            }
            .forkit-win-btn:hover {
                background-color: #dfd6f3;
                color: #1e1633;
            }
            .forkit-win-close:hover {
                background-color: #e11d48;
                color: #ffffff;
            }
            .forkit-toolbar {
                background-color: #ffffff;
                border-bottom: 1px solid #dcd3f2;
                padding: 8px 12px;
            }
            .forkit-address {
                background-color: #f6f4fc;
                color: #1e1633;
                border: 1px solid #dcd3f2;
                border-radius: 8px;
                padding: 0 14px;
                min-height: 34px;
                font-size: 13px;
                caret-color: #7c3aed;
                box-shadow: none;
            }
            .forkit-address:focus {
                border-color: #8b5cf6;
                background-color: #ffffff;
            }
            .forkit-adblock {
                background-image: none;
                background-color: #8b5cf6;
                color: #ffffff;
                border-radius: 8px;
                min-width: 36px;
                min-height: 36px;
                padding: 0;
                border: 1px solid #8b5cf6;
                box-shadow: none;
            }
            .forkit-adblock:hover {
                background-color: #7c3aed;
                border-color: #7c3aed;
            }
            .forkit-adblock.disabled {
                background-image: none;
                background-color: #f0ebf9;
                color: #6b5f84;
                border-color: #dcd3f2;
            }
            menu.forkit-tab-ctx {
                background-color: #ffffff;
                color: #1e1633;
                border: 1px solid #dcd3f2;
                border-radius: 8px;
                padding: 6px;
                box-shadow: none;
            }
            menu.forkit-tab-ctx menuitem {
                padding: 7px 14px;
                border-radius: 6px;
                color: #1e1633;
                font-size: 13px;
            }
            menu.forkit-tab-ctx menuitem:hover {
                background-color: #ede9fe;
                color: #7c3aed;
            }
            menu.forkit-tab-ctx separator {
                background-color: #dcd3f2;
                margin: 4px 6px;
                min-height: 1px;
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

        let top_bar = gtk::Box::new(gtk::Orientation::Vertical, 0);
        top_bar.style_context().add_class("forkit-topbar");
        top_bar.set_size_request(-1, 104);
        top_bar.set_vexpand(false);
        top_bar.set_valign(gtk::Align::Start);

        let make_icon_btn = |icon_name: &str, class_name: &str, tooltip: &str| {
            let btn = gtk::Button::from_icon_name(Some(icon_name), gtk::IconSize::Menu);
            btn.set_relief(gtk::ReliefStyle::None);
            btn.style_context().add_class(class_name);
            btn.set_tooltip_text(Some(tooltip));
            btn
        };

        // Row 1: Tabs + Window Controls
        let tabs_row = gtk::Box::new(gtk::Orientation::Horizontal, 4);
        tabs_row.style_context().add_class("forkit-tabs-row");
        tabs_row.set_size_request(-1, 46);

        let tabs_container = gtk::Fixed::new();
        tabs_container.set_hexpand(false);
        tabs_container.set_halign(gtk::Align::Start);
        tabs_row.pack_start(&tabs_container, false, false, 0);

        let new_tab_btn = make_icon_btn("list-add-symbolic", "forkit-icon-btn", "New Tab");
        let app_nt = app_clone.clone();
        new_tab_btn.connect_clicked(move |_| {
            create_native_tab(&app_nt, "newtab.html");
        });
        tabs_row.pack_start(&new_tab_btn, false, false, 2);

        // Draggable spacer
        let drag_area = gtk::EventBox::new();
        drag_area.set_hexpand(true);
        let app_drag = app_clone.clone();
        drag_area.connect_button_press_event(move |_, ev| {
            if ev.button() == 1 {
                if let Some(win) = app_drag.get_window("main") {
                    if ev.event_type() == gtk::gdk::EventType::DoubleButtonPress {
                        let max = win.is_maximized().unwrap_or(false);
                        if max {
                            let _ = win.unmaximize();
                        } else {
                            let _ = win.maximize();
                        }
                    } else {
                        let _ = win.start_dragging();
                    }
                }
            }
            gtk::glib::Propagation::Proceed
        });
        tabs_row.pack_start(&drag_area, true, true, 0);

        // Window controls
        let min_btn = make_icon_btn("window-minimize-symbolic", "forkit-win-btn", "Minimize");
        let app_min = app_clone.clone();
        min_btn.connect_clicked(move |_| {
            if let Some(w) = app_min.get_window("main") {
                let _ = w.minimize();
            }
        });

        let max_btn = make_icon_btn("window-maximize-symbolic", "forkit-win-btn", "Maximize");
        let app_max = app_clone.clone();
        max_btn.connect_clicked(move |_| {
            if let Some(w) = app_max.get_window("main") {
                if w.is_maximized().unwrap_or(false) {
                    let _ = w.unmaximize();
                } else {
                    let _ = w.maximize();
                }
            }
        });

        let close_btn = make_icon_btn("window-close-symbolic", "forkit-win-btn", "Close");
        close_btn.style_context().add_class("forkit-win-close");
        let app_close = app_clone.clone();
        close_btn.connect_clicked(move |_| {
            app_close.exit(0);
        });

        tabs_row.pack_end(&close_btn, false, false, 0);
        tabs_row.pack_end(&max_btn, false, false, 0);
        tabs_row.pack_end(&min_btn, false, false, 0);

        // Row 2: Toolbar
        let toolbar = gtk::Box::new(gtk::Orientation::Horizontal, 6);
        toolbar.style_context().add_class("forkit-toolbar");
        toolbar.set_size_request(-1, 58);

        let back_btn = make_icon_btn("go-previous-symbolic", "forkit-icon-btn", "Back");
        let app_back = app_clone.clone();
        back_btn.connect_clicked(move |_| go_back(&app_back));

        let forward_btn = make_icon_btn("go-next-symbolic", "forkit-icon-btn", "Forward");
        let app_fwd = app_clone.clone();
        forward_btn.connect_clicked(move |_| go_forward(&app_fwd));

        let reload_btn = make_icon_btn("view-refresh-symbolic", "forkit-icon-btn", "Reload");
        let app_rel = app_clone.clone();
        reload_btn.connect_clicked(move |_| {
            if let Some(st) = app_rel.try_state::<NativeUiState>() {
                if let Some(id) = *st.active_tab_id.lock().unwrap() {
                    let _ = reload_tab(app_rel.clone(), id);
                }
            }
        });

        let home_btn = make_icon_btn("go-home-symbolic", "forkit-icon-btn", "Home");
        let app_home = app_clone.clone();
        home_btn.connect_clicked(move |_| {
            navigate_active_tab(&app_home, "newtab.html");
        });

        let address_entry = gtk::Entry::new();
        address_entry.style_context().add_class("forkit-address");
        address_entry.set_placeholder_text(Some("Search or enter URL"));
        address_entry.set_hexpand(true);
        let app_addr = app_clone.clone();
        address_entry.connect_activate(move |entry| {
            if let Some(target) = normalize_input_url(&entry.text()) {
                navigate_active_tab(&app_addr, &target);
            }
        });

        let go_btn = make_icon_btn("go-next-symbolic", "forkit-icon-btn", "Go");
        let app_go = app_clone.clone();
        let entry_go = address_entry.clone();
        go_btn.connect_clicked(move |_| {
            if let Some(target) = normalize_input_url(&entry_go.text()) {
                navigate_active_tab(&app_go, &target);
            }
        });

        let adblock_btn = make_icon_btn("security-high-symbolic", "forkit-adblock", "DPI & Ad Blocker");
        let app_ab = app_clone.clone();
        adblock_btn.connect_clicked(move |_| {
            let _ = open_overlay_panel_inner(&app_ab, "dpi".to_string(), None);
        });

        let dl_btn = make_icon_btn("folder-download-symbolic", "forkit-icon-btn", "Downloads");
        let app_dl = app_clone.clone();
        dl_btn.connect_clicked(move |_| {
            let _ = open_overlay_panel_inner(&app_dl, "downloads".to_string(), None);
        });

        let hist_btn = make_icon_btn("document-open-recent-symbolic", "forkit-icon-btn", "History");
        let app_hist = app_clone.clone();
        hist_btn.connect_clicked(move |_| {
            let _ = open_overlay_panel_inner(&app_hist, "history".to_string(), None);
        });

        let ext_btn = make_icon_btn("application-x-addon-symbolic", "forkit-icon-btn", "Extensions");
        let app_ext = app_clone.clone();
        ext_btn.connect_clicked(move |_| {
            let _ = open_overlay_panel_inner(&app_ext, "extensions".to_string(), None);
        });

        toolbar.pack_start(&back_btn, false, false, 0);
        toolbar.pack_start(&forward_btn, false, false, 0);
        toolbar.pack_start(&reload_btn, false, false, 0);
        toolbar.pack_start(&home_btn, false, false, 0);
        toolbar.pack_start(&address_entry, true, true, 4);
        toolbar.pack_start(&go_btn, false, false, 0);
        toolbar.pack_start(&adblock_btn, false, false, 2);
        toolbar.pack_start(&dl_btn, false, false, 0);
        toolbar.pack_start(&hist_btn, false, false, 0);
        toolbar.pack_start(&ext_btn, false, false, 0);

        top_bar.pack_start(&tabs_row, false, false, 0);
        top_bar.pack_start(&toolbar, false, false, 0);
        top_bar.show_all();

        vbox.pack_start(&top_bar, false, false, 0);
        vbox.reorder_child(&top_bar, 0);

        TOP_BAR_WIDGETS.with(|cell| {
            *cell.borrow_mut() = Some(GtkTopBarWidgets {
                tabs_container,
                address_entry,
                back_btn,
                forward_btn,
                adblock_btn,
            });
        });

        crate::adblocker::init_webkit_content_blocker(&app_clone);

        // Create initial tabs from CLI arguments and/or FORKIT_BENCH_URLS
        let startup_urls = crate::collect_startup_urls();

        if startup_urls.is_empty() {
            create_native_tab(&app_clone, "newtab.html");
        } else {
            for u in startup_urls {
                create_native_tab_nosync(&app_clone, &u);
            }
            sync_gtk_ui(&app_clone);
            schedule_prewarm_newtab(&app_clone);
        }
    });
}

fn sync_gtk_ui(app: &AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static SYNC_PENDING: AtomicBool = AtomicBool::new(false);
    if SYNC_PENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app_clone = app.clone();
    let _ = app.run_on_main_thread(move || {
        SYNC_PENDING.store(false, Ordering::SeqCst);
        let Some(st) = app_clone.try_state::<NativeUiState>() else {
            return;
        };
        let tabs = st.tabs.lock().unwrap().clone();
        let active_id = *st.active_tab_id.lock().unwrap();
        let ad_enabled = app_clone
            .try_state::<AdBlockerState>()
            .and_then(|s| s.inner.lock().ok().map(|b| b.is_enabled))
            .unwrap_or(true);

        TOP_BAR_WIDGETS.with(|cell| {
            let borrow = cell.borrow();
            let Some(widgets) = borrow.as_ref() else {
                return;
            };

            for child in widgets.tabs_container.children() {
                widgets.tabs_container.remove(&child);
            }

            let mut x_cursor: i32 = 0;
            let mut anim_items: Vec<TabAnimItem> = Vec::with_capacity(tabs.len());

            for tab in &tabs {
                let tab_ev = gtk::EventBox::new();
                tab_ev.set_visible_window(false);
                tab_ev.add_events(
                    gtk::gdk::EventMask::BUTTON_PRESS_MASK
                        | gtk::gdk::EventMask::BUTTON_RELEASE_MASK
                        | gtk::gdk::EventMask::POINTER_MOTION_MASK,
                );

                let tab_box = gtk::Box::new(gtk::Orientation::Horizontal, 4);
                tab_box.style_context().add_class("forkit-tab-btn");
                if Some(tab.tab_id) == active_id {
                    tab_box.style_context().add_class("active");
                }

                let mut short_title = tab.title.trim().to_string();
                if short_title.is_empty() {
                    short_title = "New Tab".to_string();
                }
                if short_title.chars().count() > 18 {
                    short_title = format!("{}…", short_title.chars().take(17).collect::<String>());
                }

                let favicon = TAB_FAVICONS.with(|favs| {
                    if let Some(pb) = favs.borrow().get(&tab.tab_id) {
                        gtk::Image::from_pixbuf(Some(pb))
                    } else {
                        gtk::Image::from_icon_name(
                            Some("applications-internet-symbolic"),
                            gtk::IconSize::Menu,
                        )
                    }
                });
                let title_lbl = gtk::Label::new(Some(&short_title));
                title_lbl.style_context().add_class("forkit-tab-label");
                title_lbl.set_halign(gtk::Align::Start);

                let tid = tab.tab_id;
                let tab_url = tab.url.clone();

                let close_btn = gtk::Button::from_icon_name(
                    Some("window-close-symbolic"),
                    gtk::IconSize::Menu,
                );
                close_btn.style_context().add_class("forkit-tab-close");
                close_btn.set_relief(gtk::ReliefStyle::None);
                let app_cl = app_clone.clone();
                close_btn.connect_clicked(move |_| {
                    close_native_tab(&app_cl, tid);
                });

                let app_press = app_clone.clone();
                tab_ev.connect_button_press_event(move |_, ev| {
                    if ev.button() == 1 {
                        let (rx, _) = ev.root();
                        TAB_DRAG_STATE.with(|d| {
                            *d.borrow_mut() = Some(TabDragState {
                                tab_id: tid,
                                start_root_x: rx,
                                last_root_x: rx,
                                did_drag: false,
                            });
                        });
                        return gtk::glib::Propagation::Stop;
                    } else if ev.button() == 3 {
                        show_tab_context_menu(&app_press, tid, &tab_url, ev);
                        return gtk::glib::Propagation::Stop;
                    }
                    gtk::glib::Propagation::Proceed
                });

                let container_motion = widgets.tabs_container.clone();
                let app_motion = app_clone.clone();
                tab_ev.connect_motion_notify_event(move |ev_box, ev| {
                    let (rx, _) = ev.root();
                    let drag_dx = TAB_DRAG_STATE.with(|d| {
                        let mut guard = d.borrow_mut();
                        if let Some(ds) = guard.as_mut() {
                            if ds.tab_id == tid {
                                if !ds.did_drag && (rx - ds.start_root_x).abs() > 8.0 {
                                    ds.did_drag = true;
                                }
                                if ds.did_drag {
                                    let dx = rx - ds.last_root_x;
                                    ds.last_root_x = rx;
                                    return Some(dx);
                                }
                            }
                        }
                        None
                    });
                    if let Some(dx) = drag_dx {
                        let drag_info = TAB_ANIM_STATE.with(|a| {
                            let mut anim = a.borrow_mut();
                            let total_w: f64 = anim
                                .items
                                .iter()
                                .map(|it| it.width as f64 + 4.0)
                                .sum::<f64>()
                                - 4.0;
                            if let Some(it) = anim.items.iter_mut().find(|it| it.tab_id == tid) {
                                let max_x = (total_w - it.width as f64).max(0.0);
                                it.current_x = (it.current_x + dx).clamp(0.0, max_x);
                                Some((it.current_x, it.width))
                            } else {
                                None
                            }
                        });
                        if let Some((new_x, drag_w)) = drag_info {
                            container_motion.move_(ev_box, new_x.round() as i32, 0);
                            let drag_center = new_x + drag_w as f64 / 2.0;

                            if let Some(st) = app_motion.try_state::<NativeUiState>() {
                                let mut tabs_lock = st.tabs.lock().unwrap();
                                if let Some(src_i) = tabs_lock.iter().position(|t| t.tab_id == tid) {
                                    let dst_i = TAB_ANIM_STATE.with(|a| {
                                        let anim = a.borrow();
                                        let mut slot_x = 0.0;
                                        let mut found = tabs_lock.len().saturating_sub(1);
                                        for (idx, t) in tabs_lock.iter().enumerate() {
                                            let w = anim
                                                .items
                                                .iter()
                                                .find(|it| it.tab_id == t.tab_id)
                                                .map(|it| it.width as f64)
                                                .unwrap_or(140.0);
                                            if drag_center < slot_x + w + 2.0 {
                                                found = idx;
                                                break;
                                            }
                                            slot_x += w + 4.0;
                                        }
                                        found
                                    });
                                    if src_i != dst_i && dst_i < tabs_lock.len() {
                                        let item = tabs_lock.remove(src_i);
                                        tabs_lock.insert(dst_i, item);
                                        update_tab_targets(&tabs_lock);
                                        ensure_tab_anim_timer(&container_motion);
                                    }
                                }
                            }
                        }
                    }
                    gtk::glib::Propagation::Proceed
                });

                let app_rel = app_clone.clone();
                let container_rel = widgets.tabs_container.clone();
                tab_ev.connect_button_release_event(move |_, ev| {
                    if ev.button() == 1 {
                        let state_opt = TAB_DRAG_STATE.with(|d| d.borrow_mut().take());
                        if let Some(ds) = state_opt {
                            if ds.tab_id == tid {
                                if ds.did_drag {
                                    if let Some(st) = app_rel.try_state::<NativeUiState>() {
                                        let tabs_lock = st.tabs.lock().unwrap();
                                        update_tab_targets(&tabs_lock);
                                    }
                                    ensure_tab_anim_timer(&container_rel);
                                } else {
                                    switch_native_tab(&app_rel, tid);
                                }
                            }
                        }
                    }
                    gtk::glib::Propagation::Proceed
                });

                tab_box.set_hexpand(false);
                tab_box.pack_start(&favicon, false, false, 2);
                tab_box.pack_start(&title_lbl, false, false, 4);
                tab_box.pack_end(&close_btn, false, false, 0);
                tab_ev.add(&tab_box);
                tab_ev.show_all();
                let (_, nat) = tab_ev.preferred_size();
                let w = nat.width.max(140);
                widgets.tabs_container.put(&tab_ev, x_cursor, 0);
                anim_items.push(TabAnimItem {
                    tab_id: tid,
                    widget: tab_ev,
                    current_x: x_cursor as f64,
                    target_x: x_cursor as f64,
                    width: w,
                });
                x_cursor += w + 4;
            }
            TAB_ANIM_STATE.with(|a| {
                a.borrow_mut().items = anim_items;
            });
            widgets.tabs_container.show_all();

            if let Some(active) = tabs.iter().find(|t| Some(t.tab_id) == active_id) {
                let display_url = if active.url.contains("newtab.html") {
                    ""
                } else {
                    active.url.as_str()
                };
                if widgets.address_entry.text().as_str() != display_url {
                    widgets.address_entry.set_text(display_url);
                }
                widgets.back_btn.set_sensitive(active.can_go_back);
                widgets.forward_btn.set_sensitive(active.can_go_forward);
            }

            if ad_enabled {
                widgets.adblock_btn.style_context().remove_class("disabled");
            } else {
                widgets.adblock_btn.style_context().add_class("disabled");
            }
        });
    });
}

fn schedule_prewarm_newtab(app: &AppHandle) {
    let app_bg = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(120));
        let app_main = app_bg.clone();
        let _ = app_bg.run_on_main_thread(move || {
            let Some(tab_state) = app_main.try_state::<TabManagerState>() else {
                return;
            };
            if tab_state.spare_newtab_id.lock().unwrap().is_some() {
                return;
            }
            let Some(st) = app_main.try_state::<NativeUiState>() else {
                return;
            };
            let spare_id = {
                let mut next = st.next_tab_id.lock().unwrap();
                *next += 1;
                *next
            };
            *tab_state.spare_newtab_id.lock().unwrap() = Some(spare_id);
            if create_tab_webview_hidden(
                &app_main,
                spare_id,
                "newtab.html".to_string(),
                default_bounds(&app_main),
            )
            .is_err()
            {
                *tab_state.spare_newtab_id.lock().unwrap() = None;
            }
        });
    });
}

fn create_native_tab_nosync(app: &AppHandle, url: &str) {
    let Some(st) = app.try_state::<NativeUiState>() else {
        return;
    };
    let is_newtab = url == "newtab.html" || url.ends_with("/newtab.html");
    let bounds = default_bounds(app);

    if is_newtab {
        if let Some(tab_id) = claim_spare_newtab(app, bounds) {
            {
                let mut tabs = st.tabs.lock().unwrap();
                tabs.push(NativeTabInfo {
                    tab_id,
                    title: "New Tab".to_string(),
                    url: url.to_string(),
                    can_go_back: false,
                    can_go_forward: false,
                });
            }
            *st.active_tab_id.lock().unwrap() = Some(tab_id);
            schedule_prewarm_newtab(app);
            return;
        }
    }

    let tab_id = {
        let mut next = st.next_tab_id.lock().unwrap();
        *next += 1;
        *next
    };

    {
        let mut tabs = st.tabs.lock().unwrap();
        tabs.push(NativeTabInfo {
            tab_id,
            title: "New Tab".to_string(),
            url: url.to_string(),
            can_go_back: false,
            can_go_forward: false,
        });
    }
    *st.active_tab_id.lock().unwrap() = Some(tab_id);

    let _ = create_tab_webview_inner(app, tab_id, url.to_string(), bounds);
    if is_newtab {
        schedule_prewarm_newtab(app);
    }
}

pub fn create_native_tab(app: &AppHandle, url: &str) {
    create_native_tab_nosync(app, url);
    sync_gtk_ui(app);
}

pub fn switch_native_tab(app: &AppHandle, tab_id: u64) {
    if let Some(st) = app.try_state::<NativeUiState>() {
        *st.active_tab_id.lock().unwrap() = Some(tab_id);
    }
    let _ = switch_tab_webview_inner(app, tab_id, default_bounds(app));
    sync_gtk_ui(app);
}

fn show_tab_context_menu(app: &AppHandle, tab_id: u64, tab_url: &str, ev: &gtk::gdk::EventButton) {
    let menu = gtk::Menu::new();
    menu.set_reserve_toggle_size(false);
    menu.style_context().add_class("forkit-tab-ctx");

    let add_item = |label: &str, on_click: Box<dyn Fn()>| {
        let item = gtk::MenuItem::with_label(label);
        item.connect_activate(move |_| on_click());
        menu.append(&item);
    };

    let app_rel = app.clone();
    add_item(
        "Reload Tab",
        Box::new(move || {
            let _ = reload_tab(app_rel.clone(), tab_id);
        }),
    );

    let app_dup = app.clone();
    let dup_url = tab_url.to_string();
    add_item(
        "Duplicate Tab",
        Box::new(move || {
            create_native_tab(&app_dup, &dup_url);
        }),
    );

    menu.append(&gtk::SeparatorMenuItem::new());

    let app_cl = app.clone();
    add_item(
        "Close Tab",
        Box::new(move || {
            close_native_tab(&app_cl, tab_id);
        }),
    );

    let app_other = app.clone();
    add_item(
        "Close Other Tabs",
        Box::new(move || {
            let others: Vec<u64> = app_other
                .try_state::<NativeUiState>()
                .map(|st| {
                    st.tabs
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|t| t.tab_id != tab_id)
                        .map(|t| t.tab_id)
                        .collect()
                })
                .unwrap_or_default();
            for oid in others {
                close_native_tab(&app_other, oid);
            }
        }),
    );

    menu.show_all();
    menu.popup_at_pointer(Some(ev));
}

pub fn close_native_tab(app: &AppHandle, tab_id: u64) {
    let next_active = if let Some(st) = app.try_state::<NativeUiState>() {
        let mut tabs = st.tabs.lock().unwrap();
        let idx = tabs.iter().position(|t| t.tab_id == tab_id);
        if let Some(i) = idx {
            tabs.remove(i);
        }
        if tabs.is_empty() {
            app.exit(0);
            return;
        }
        let cur_active = *st.active_tab_id.lock().unwrap();
        if cur_active == Some(tab_id) {
            let pick = idx.unwrap_or(0).saturating_sub(1);
            Some(tabs[pick].tab_id)
        } else {
            None
        }
    } else {
        None
    };

    TAB_FAVICONS.with(|favs| {
        favs.borrow_mut().remove(&tab_id);
    });
    let _ = close_tab_webview_inner(app, tab_id);
    if let Some(next_id) = next_active {
        switch_native_tab(app, next_id);
    } else {
        sync_gtk_ui(app);
    }
}

fn navigate_active_tab(app: &AppHandle, url: &str) {
    let active_id = app
        .try_state::<NativeUiState>()
        .and_then(|st| *st.active_tab_id.lock().unwrap());
    if let Some(id) = active_id {
        let _ = navigate_tab(app.clone(), id, url.to_string());
    }
}

fn go_back(app: &AppHandle) {
    let active_id = app
        .try_state::<NativeUiState>()
        .and_then(|st| *st.active_tab_id.lock().unwrap());
    if let Some(id) = active_id {
        go_back_tab(app, id);
    }
}

fn go_forward(app: &AppHandle) {
    let active_id = app
        .try_state::<NativeUiState>()
        .and_then(|st| *st.active_tab_id.lock().unwrap());
    if let Some(id) = active_id {
        go_forward_tab(app, id);
    }
}

pub fn on_tab_uri_changed(
    app: &AppHandle,
    tab_id: u64,
    url: &str,
    can_go_back: bool,
    can_go_forward: bool,
) {
    let mut url_changed = false;
    let mut recorded_title = String::new();
    if let Some(st) = app.try_state::<NativeUiState>() {
        let mut tabs = st.tabs.lock().unwrap();
        if let Some(tab) = tabs.iter_mut().find(|t| t.tab_id == tab_id) {
            if !url.is_empty() && tab.url != url {
                tab.url = url.to_string();
                url_changed = true;
            }
            tab.can_go_back = can_go_back;
            tab.can_go_forward = can_go_forward;
            recorded_title = tab.title.clone();
        }
    }
    if url_changed {
        crate::gtk_panels::record_history(app, url, &recorded_title);
    }
    sync_gtk_ui(app);
}

pub fn on_tab_favicon_changed(app: &AppHandle, tab_id: u64, pixbuf: gtk::gdk_pixbuf::Pixbuf) {
    TAB_FAVICONS.with(|favs| {
        favs.borrow_mut().insert(tab_id, pixbuf);
    });
    sync_gtk_ui(app);
}

pub fn on_tab_loading_started(app: &AppHandle, tab_id: u64) {
    if let Some(st) = app.try_state::<NativeUiState>() {
        let mut tabs = st.tabs.lock().unwrap();
        if let Some(tab) = tabs.iter_mut().find(|t| t.tab_id == tab_id) {
            tab.title = "Loading...".to_string();
        }
    }
    sync_gtk_ui(app);
}

pub fn on_tab_loaded(app: &AppHandle, tab_id: u64, url: &str) {
    let mut recorded_title = String::new();
    if let Some(st) = app.try_state::<NativeUiState>() {
        if url.contains("newtab.html") {
            let mut base = st.base_app_url.lock().unwrap();
            if base.is_none() {
                *base = Some(url.to_string());
            }
        }
        let mut tabs = st.tabs.lock().unwrap();
        if let Some(tab) = tabs.iter_mut().find(|t| t.tab_id == tab_id) {
            tab.url = url.to_string();
            recorded_title = tab.title.clone();
        }
    }
    crate::gtk_panels::record_history(app, url, &recorded_title);
    sync_gtk_ui(app);
}

pub fn on_tab_title_changed(app: &AppHandle, tab_id: u64, title: &str) {
    let mut tab_url = String::new();
    let new_title = if title.trim().is_empty() {
        "New Tab".to_string()
    } else {
        title.to_string()
    };
    if let Some(st) = app.try_state::<NativeUiState>() {
        let mut tabs = st.tabs.lock().unwrap();
        if let Some(tab) = tabs.iter_mut().find(|t| t.tab_id == tab_id) {
            tab.title = new_title.clone();
            tab_url = tab.url.clone();
        }
    }
    crate::gtk_panels::update_history_title(app, &tab_url, &new_title);
    sync_gtk_ui(app);
}

pub fn on_tab_new_window(app: &AppHandle, _tab_id: u64, url: &str) {
    let app_clone = app.clone();
    let url_str = url.to_string();
    let _ = app.run_on_main_thread(move || {
        create_native_tab(&app_clone, &url_str);
    });
}

pub fn on_download_requested(app: &AppHandle, url: String, filename: String) {
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = download_item(app_clone, url, filename).await;
    });
}

pub fn get_active_tab_info(app: &AppHandle) -> (u64, String, String) {
    if let Some(st) = app.try_state::<NativeUiState>() {
        let active_id = *st.active_tab_id.lock().unwrap();
        if let Some(id) = active_id {
            let tabs = st.tabs.lock().unwrap();
            if let Some(tab) = tabs.iter().find(|t| t.tab_id == id) {
                return (tab.tab_id, tab.url.clone(), tab.title.clone());
            }
        }
    }
    (1, String::new(), String::new())
}

pub fn open_new_tab_from_extension(app: &AppHandle, url: &str) {
    let app_clone = app.clone();
    let url_str = url.to_string();
    let _ = app.run_on_main_thread(move || {
        create_native_tab(&app_clone, &url_str);
    });
}
