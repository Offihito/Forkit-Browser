use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Webview, WebviewUrl,
};

use crate::adblocker::{AdBlockerState, TAB_INIT_SCRIPT};

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct TabBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub struct TabManagerState {
    pub active_tab_id: Mutex<Option<u64>>,
    pub overlay_open: Mutex<bool>,
    pub top_bar_height: Mutex<f64>,
    pub window_size: Mutex<(f64, f64)>,
    pub hibernated_tabs: Mutex<HashSet<u64>>,
    pub tab_hide_gen: Mutex<HashMap<u64, u64>>,
}

impl Default for TabManagerState {
    fn default() -> Self {
        Self {
            active_tab_id: Mutex::new(None),
            overlay_open: Mutex::new(false),
            top_bar_height: Mutex::new(104.0),
            window_size: Mutex::new((1400.0, 800.0)),
            hibernated_tabs: Mutex::new(HashSet::new()),
            tab_hide_gen: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TabLoadPayload {
    tab_id: u64,
    url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TabTitlePayload {
    tab_id: u64,
    title: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TabNewWindowPayload {
    tab_id: u64,
    url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TabDownloadPayload {
    url: String,
    filename: String,
}

fn tab_label(tab_id: u64) -> String {
    format!("tab-{}", tab_id)
}

fn resolve_webview_url(raw: &str) -> WebviewUrl {
    if raw == "newtab.html" || raw.ends_with("/newtab.html") {
        WebviewUrl::App("newtab.html".into())
    } else if let Ok(parsed) = url::Url::parse(raw) {
        WebviewUrl::External(parsed)
    } else {
        WebviewUrl::App("newtab.html".into())
    }
}

fn get_tab_webview(app: &AppHandle, tab_id: u64) -> Option<Webview> {
    app.get_webview(&tab_label(tab_id))
}

pub fn set_overlay_only(app: &AppHandle, tab_state: &TabManagerState, open: bool) {
    *tab_state.overlay_open.lock().unwrap() = open;

    #[cfg(target_os = "linux")]
    {
        let app_clone = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(overlay_wv) = app_clone.get_webview("overlay") {
                if open {
                    let _ = overlay_wv.show();
                    let _ = overlay_wv.set_focus();
                } else {
                    let _ = overlay_wv.hide();
                }
            }
        });
    }

    #[cfg(not(target_os = "linux"))]
    {
        apply_layout(app, tab_state);
    }
}

pub fn apply_layout(app: &AppHandle, tab_state: &TabManagerState) {
    let overlay_open = *tab_state.overlay_open.lock().unwrap();
    let top_bar_height = (*tab_state.top_bar_height.lock().unwrap()).max(40.0);
    let (win_w, win_h) = *tab_state.window_size.lock().unwrap();
    let active_id = *tab_state.active_tab_id.lock().unwrap();

    #[cfg(target_os = "linux")]
    {
        let _ = (win_w, win_h);
        let app_clone = app.clone();
        let _ = app.run_on_main_thread(move || {
            use gtk::prelude::*;
            if let Some(main_win) = app_clone.get_window("main") {
                if let Ok(vbox) = main_win.default_vbox() {
                    // Find or create gtk::Overlay + content_box inside vbox
                    let children = vbox.children();
                    if let Some(ui_widget) = children.first() {
                        ui_widget.set_size_request(-1, top_bar_height.round() as i32);
                        ui_widget.set_vexpand(false);
                        ui_widget.set_valign(gtk::Align::Start);
                        vbox.set_child_packing(ui_widget, false, false, 0, gtk::PackType::Start);
                    }

                    // Ensure gtk::Overlay exists as the 2nd child of vbox
                    let existing_overlay = children
                        .iter()
                        .find_map(|w| w.clone().downcast::<gtk::Overlay>().ok());

                    let (gtk_overlay, content_box) = if let Some(ov) = existing_overlay {
                        let cb = ov
                            .child()
                            .and_then(|c| c.downcast::<gtk::Box>().ok())
                            .unwrap_or_else(|| {
                                let b = gtk::Box::new(gtk::Orientation::Vertical, 0);
                                ov.add(&b);
                                b.show();
                                b
                            });
                        (ov, cb)
                    } else {
                        let ov = gtk::Overlay::new();
                        let cb = gtk::Box::new(gtk::Orientation::Vertical, 0);
                        cb.set_vexpand(true);
                        cb.set_hexpand(true);
                        ov.add(&cb);
                        ov.set_vexpand(true);
                        ov.set_hexpand(true);
                        vbox.pack_start(&ov, true, true, 0);
                        cb.show();
                        ov.show();
                        (ov, cb)
                    };

                    // Move any newly added WebKitWebView children (after ui_widget) into content_box or overlay
                    let mut moved_any = false;
                    for child in vbox.children().into_iter().skip(1) {
                        if child.clone().downcast::<gtk::Overlay>().is_ok() {
                            continue;
                        }
                        vbox.remove(&child);
                        let is_overlay_wv = unsafe { child.data::<bool>("forkit_is_overlay").is_some() };
                        if is_overlay_wv {
                            gtk_overlay.add_overlay(&child);
                        } else {
                            child.set_vexpand(true);
                            child.set_valign(gtk::Align::Fill);
                            content_box.pack_start(&child, true, true, 0);
                        }
                        moved_any = true;
                    }

                    if moved_any {
                        vbox.queue_resize();
                    }
                }
            }

            if let Some(overlay_wv) = app_clone.get_webview("overlay") {
                if overlay_open {
                    let _ = overlay_wv.show();
                    let _ = overlay_wv.set_focus();
                } else {
                    let _ = overlay_wv.hide();
                }
            }
            if let Some(tab_id) = active_id {
                if let Some(wv) = get_tab_webview(&app_clone, tab_id) {
                    let _ = wv.show();
                }
            }
        });
    }

    #[cfg(not(target_os = "linux"))]
    {
        let content_h = (win_h - top_bar_height).max(100.0);
        if let Some(ui) = app.get_webview("ui") {
            let _ = ui.set_position(LogicalPosition::new(0.0, 0.0));
            let _ = ui.set_size(LogicalSize::new(win_w.max(100.0), top_bar_height));
        }

        if let Some(tab_id) = active_id {
            if let Some(wv) = get_tab_webview(app, tab_id) {
                let _ = wv.set_position(LogicalPosition::new(0.0, top_bar_height));
                let _ = wv.set_size(LogicalSize::new(win_w.max(100.0), content_h));
                let _ = wv.show();
            }
        }

        if let Some(overlay_wv) = app.get_webview("overlay") {
            if overlay_open {
                let _ = overlay_wv.set_position(LogicalPosition::new(0.0, top_bar_height));
                let _ = overlay_wv.set_size(LogicalSize::new(win_w.max(100.0), content_h));
                let _ = overlay_wv.show();
            } else {
                let _ = overlay_wv.hide();
            }
        }
    }
}

#[tauri::command]
pub fn create_tab_webview(
    app: AppHandle,
    _tab_state: State<'_, TabManagerState>,
    tab_id: u64,
    url: String,
    bounds: TabBounds,
) -> Result<(), String> {
    create_tab_webview_inner(&app, tab_id, url, bounds)
}

pub fn create_tab_webview_inner(
    app: &AppHandle,
    tab_id: u64,
    url: String,
    bounds: TabBounds,
) -> Result<(), String> {
    let tab_state = app
        .try_state::<TabManagerState>()
        .ok_or_else(|| "TabManagerState not found".to_string())?;
    if bounds.y > 20.0 {
        *tab_state.top_bar_height.lock().unwrap() = bounds.y;
    }

    let main_window = app
        .get_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    if let Some(prev_id) = *tab_state.active_tab_id.lock().unwrap() {
        if let Some(prev_wv) = get_tab_webview(app, prev_id) {
            let _ = prev_wv.hide();
        }
    }

    let label = tab_label(tab_id);
    let wv_url = resolve_webview_url(&url);

    let app_for_load = app.clone();
    let app_for_title = app.clone();
    let app_for_nav = app.clone();
    let app_for_new_win = app.clone();
    let app_for_dl = app.clone();

    let builder = WebviewBuilder::new(label, wv_url)
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .initialization_script(TAB_INIT_SCRIPT)
        .on_navigation(move |nav_url| {
            let url_str = nav_url.as_str();
            if let Some(ad_state) = app_for_nav.try_state::<AdBlockerState>() {
                if let Ok(mut blocker) = ad_state.inner.lock() {
                    if blocker.should_block(url_str) {
                        return false;
                    }
                }
            }
            true
        })
        .on_page_load(move |_wv, payload| {
            let url_str = payload.url().to_string();
            match payload.event() {
                PageLoadEvent::Started => {
                    #[cfg(target_os = "linux")]
                    crate::gtk_ui::on_tab_loading_started(&app_for_load, tab_id);
                    let _ = app_for_load.emit(
                        "tab-loading-started",
                        TabLoadPayload {
                            tab_id,
                            url: url_str,
                        },
                    );
                }
                PageLoadEvent::Finished => {
                    #[cfg(target_os = "linux")]
                    crate::gtk_ui::on_tab_loaded(&app_for_load, tab_id, &url_str);
                    let _ = app_for_load.emit(
                        "tab-loaded",
                        TabLoadPayload {
                            tab_id,
                            url: url_str,
                        },
                    );
                }
            }
        })
        .on_document_title_changed(move |_wv, title| {
            #[cfg(target_os = "linux")]
            crate::gtk_ui::on_tab_title_changed(&app_for_title, tab_id, &title);
            let _ = app_for_title.emit(
                "tab-title-changed",
                TabTitlePayload { tab_id, title },
            );
        })
        .on_new_window(move |new_url, _features| {
            let url_str = new_url.to_string();
            #[cfg(target_os = "linux")]
            crate::gtk_ui::on_tab_new_window(&app_for_new_win, tab_id, &url_str);
            let _ = app_for_new_win.emit(
                "tab-new-window",
                TabNewWindowPayload {
                    tab_id,
                    url: url_str,
                },
            );
            NewWindowResponse::Deny
        })
        .on_download(move |_wv, event| {
            if let DownloadEvent::Requested { url, destination } = event {
                let filename = destination
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| {
                        url.path_segments()
                            .and_then(|s| s.last())
                            .filter(|s| !s.is_empty())
                            .unwrap_or("download")
                            .to_string()
                    });
                #[cfg(target_os = "linux")]
                crate::gtk_ui::on_download_requested(&app_for_dl, url.to_string(), filename.clone());
                let _ = app_for_dl.emit(
                    "start-download-from-webview",
                    TabDownloadPayload {
                        url: url.to_string(),
                        filename,
                    },
                );
                return false;
            }
            true
        });

    let top_bar_height = (*tab_state.top_bar_height.lock().unwrap()).max(40.0);
    let (win_w, win_h) = *tab_state.window_size.lock().unwrap();
    let tab_h = (win_h - top_bar_height).max(100.0);

    let child = main_window
        .add_child(
            builder,
            LogicalPosition::new(0.0, top_bar_height),
            LogicalSize::new(win_w.max(100.0), tab_h),
        )
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "linux")]
    {
        let app_for_ctx = app.clone();
        let _ = child.with_webview(move |platform_wv| {
            use gtk::prelude::*;
            use webkit2gtk::{
                CacheModel, ContextMenuExt, HitTestResultExt, SettingsExt, WebContextExt,
                WebInspectorExt, WebViewExt,
            };
            let wk = platform_wv.inner();
            let app_uri = app_for_ctx.clone();
            wk.connect_uri_notify(move |wv| {
                let uri = wv.uri().map(|s| s.to_string()).unwrap_or_default();
                crate::gtk_ui::on_tab_uri_changed(
                    &app_uri,
                    tab_id,
                    &uri,
                    wv.can_go_back(),
                    wv.can_go_forward(),
                );
            });
            if let Some(ctx) = WebViewExt::context(&wk) {
                ctx.set_cache_model(CacheModel::DocumentViewer);
                ctx.set_favicon_database_directory(None);
            }
            let app_fav = app_for_ctx.clone();
            wk.connect_favicon_notify(move |wv| {
                if let Some(surface) = wv.favicon() {
                    if let Ok(img_surf) = unsafe {
                        gtk::cairo::ImageSurface::from_raw_none(surface.to_raw_none())
                    } {
                        let w = img_surf.width();
                        let h = img_surf.height();
                        if w > 0 && h > 0 {
                            if let Some(pb) =
                                gtk::gdk::pixbuf_get_from_surface(&surface, 0, 0, w, h)
                            {
                                if let Some(scaled) = pb.scale_simple(
                                    16,
                                    16,
                                    gtk::gdk_pixbuf::InterpType::Bilinear,
                                ) {
                                    crate::gtk_ui::on_tab_favicon_changed(
                                        &app_fav, tab_id, scaled,
                                    );
                                }
                            }
                        }
                    }
                }
            });
            if let Some(settings) = WebViewExt::settings(&wk) {
                settings.set_enable_page_cache(false);
                settings.set_enable_offline_web_application_cache(false);
                settings.set_enable_html5_database(false);
                settings.set_enable_hyperlink_auditing(false);
                settings.set_enable_dns_prefetching(true);
                settings.set_enable_developer_extras(false);
            }

            thread_local! {
                static CTX_MENU_CSS: gtk::CssProvider = {
                    let provider = gtk::CssProvider::new();
                    let _ = provider.load_from_data(
                        b"
                        menu.forkit-ctx-menu {
                            background-color: #1b1b22;
                            color: #eceef4;
                            border: 1px solid rgba(255,255,255,0.14);
                            border-radius: 10px;
                            padding: 6px;
                            box-shadow: none;
                        }
                        menu.forkit-ctx-menu menuitem {
                            padding: 7px 14px;
                            border-radius: 6px;
                            color: #eceef4;
                            font-size: 13px;
                            transition: background-color 120ms ease;
                        }
                        menu.forkit-ctx-menu menuitem:hover {
                            background-color: rgba(138, 180, 248, 0.2);
                            color: #ffffff;
                        }
                        menu.forkit-ctx-menu menuitem:disabled {
                            color: rgba(236, 238, 244, 0.35);
                        }
                        menu.forkit-ctx-menu separator {
                            background-color: rgba(255,255,255,0.1);
                            margin: 4px 6px;
                            min-height: 1px;
                        }
                        .forkit-ctx-shortcut {
                            color: rgba(236, 238, 244, 0.45);
                            font-size: 11px;
                        }
                        ",
                    );
                    provider
                };
            }
            let css = CTX_MENU_CSS.with(|p| p.clone());

            let app_ctx = app_for_ctx.clone();
            wk.connect_context_menu(move |wv, wk_menu, event, hit| {
                // If the page prevented/replaced the default context menu (e.g. YouTube player),
                // WebKitGTK provides an empty ContextMenu; let the page handle it.
                if wk_menu.n_items() == 0 {
                    return false;
                }

                let menu = gtk::Menu::new();
                menu.set_reserve_toggle_size(false);
                menu.style_context().add_class("forkit-ctx-menu");
                menu.style_context()
                    .add_provider(&css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);

                let add_item = |icon_name: &str, label: &str, shortcut: &str, sensitive: bool, on_click: Box<dyn Fn()>| {
                    let item = gtk::MenuItem::new();
                    item.style_context()
                        .add_provider(&css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
                    let row = gtk::Box::new(gtk::Orientation::Horizontal, 10);
                    let icon = gtk::Image::from_icon_name(Some(icon_name), gtk::IconSize::Menu);
                    let lbl = gtk::Label::new(Some(label));
                    lbl.set_xalign(0.0);
                    row.pack_start(&icon, false, false, 0);
                    row.pack_start(&lbl, true, true, 0);
                    if !shortcut.is_empty() {
                        let sc = gtk::Label::new(Some(shortcut));
                        sc.style_context().add_class("forkit-ctx-shortcut");
                        sc.style_context()
                            .add_provider(&css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
                        row.pack_end(&sc, false, false, 4);
                    }
                    item.add(&row);
                    item.set_sensitive(sensitive);
                    item.connect_activate(move |_| on_click());
                    menu.append(&item);
                };

                let add_sep = || {
                    let sep = gtk::SeparatorMenuItem::new();
                    sep.style_context()
                        .add_provider(&css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
                    menu.append(&sep);
                };

                if hit.context_is_selection() {
                    let wv_copy = wv.clone();
                    add_item(
                        "edit-copy-symbolic",
                        "Copy",
                        "Ctrl+C",
                        true,
                        Box::new(move || {
                            wv_copy.evaluate_javascript("document.execCommand('copy')", None, None, None::<&gtk::gio::Cancellable>, |_| {});
                        }),
                    );
                    let app_search = app_ctx.clone();
                    let wv_search = wv.clone();
                    add_item(
                        "edit-find-symbolic",
                        "Search Google for selection",
                        "",
                        true,
                        Box::new(move || {
                            let app_inner = app_search.clone();
                            wv_search.evaluate_javascript(
                                "window.getSelection ? window.getSelection().toString().trim() : ''",
                                None,
                                None,
                                None::<&gtk::gio::Cancellable>,
                                move |res| {
                                    if let Ok(val) = res {
                                        let s = val.to_string();
                                        let trimmed = s.trim();
                                        if !trimmed.is_empty() {
                                            let url = format!("https://www.google.com/search?q={}", url::form_urlencoded::byte_serialize(trimmed.as_bytes()).collect::<String>());
                                            crate::gtk_ui::create_native_tab(&app_inner, &url);
                                        }
                                    }
                                },
                            );
                        }),
                    );
                    add_sep();
                }

                if hit.context_is_link() {
                    if let Some(link_uri) = hit.link_uri() {
                        let link_str = link_uri.to_string();
                        let app_open = app_ctx.clone();
                        let link_open = link_str.clone();
                        add_item(
                            "tab-new-symbolic",
                            "Open link in new tab",
                            "",
                            true,
                            Box::new(move || {
                                crate::gtk_ui::create_native_tab(&app_open, &link_open);
                            }),
                        );
                        add_item(
                            "insert-link-symbolic",
                            "Copy link address",
                            "",
                            true,
                            Box::new(move || {
                                if let Ok(mut cb) = arboard::Clipboard::new() {
                                    let _ = cb.set_text(link_str.clone());
                                }
                            }),
                        );
                        add_sep();
                    }
                }

                if hit.context_is_image() {
                    if let Some(img_uri) = hit.image_uri() {
                        let img_str = img_uri.to_string();
                        let app_img = app_ctx.clone();
                        let img_open = img_str.clone();
                        add_item(
                            "image-x-generic-symbolic",
                            "Open image in new tab",
                            "",
                            true,
                            Box::new(move || {
                                crate::gtk_ui::create_native_tab(&app_img, &img_open);
                            }),
                        );
                        let img_copy = img_str.clone();
                        add_item(
                            "edit-copy-symbolic",
                            "Copy image address",
                            "",
                            true,
                            Box::new(move || {
                                if let Ok(mut cb) = arboard::Clipboard::new() {
                                    let _ = cb.set_text(img_copy.clone());
                                }
                            }),
                        );
                        let app_dl = app_ctx.clone();
                        add_item(
                            "folder-download-symbolic",
                            "Save image as...",
                            "",
                            true,
                            Box::new(move || {
                                let filename = img_str
                                    .split('/')
                                    .last()
                                    .unwrap_or("image.png")
                                    .split('?')
                                    .next()
                                    .unwrap_or("image.png")
                                    .to_string();
                                crate::gtk_ui::on_download_requested(&app_dl, img_str.clone(), filename);
                            }),
                        );
                        add_sep();
                    }
                }

                if hit.context_is_editable() {
                    let wv_paste = wv.clone();
                    add_item(
                        "edit-paste-symbolic",
                        "Paste",
                        "Ctrl+V",
                        true,
                        Box::new(move || {
                            wv_paste.evaluate_javascript("document.execCommand('paste')", None, None, None::<&gtk::gio::Cancellable>, |_| {});
                        }),
                    );
                    let wv_cut = wv.clone();
                    add_item(
                        "edit-cut-symbolic",
                        "Cut",
                        "Ctrl+X",
                        true,
                        Box::new(move || {
                            wv_cut.evaluate_javascript("document.execCommand('cut')", None, None, None::<&gtk::gio::Cancellable>, |_| {});
                        }),
                    );
                    add_sep();
                }

                let wv_back = wv.clone();
                add_item(
                    "go-previous-symbolic",
                    "Back",
                    "Alt+←",
                    wv.can_go_back(),
                    Box::new(move || wv_back.go_back()),
                );
                let wv_fwd = wv.clone();
                add_item(
                    "go-next-symbolic",
                    "Forward",
                    "Alt+→",
                    wv.can_go_forward(),
                    Box::new(move || wv_fwd.go_forward()),
                );
                let wv_reload = wv.clone();
                add_item(
                    "view-refresh-symbolic",
                    "Refresh",
                    "Ctrl+R",
                    true,
                    Box::new(move || wv_reload.reload()),
                );
                add_sep();

                let app_print = app_ctx.clone();
                add_item(
                    "printer-symbolic",
                    "Print...",
                    "Ctrl+P",
                    true,
                    Box::new(move || {
                        let _ = print_tab(app_print.clone(), tab_id);
                    }),
                );
                let wv_insp = wv.clone();
                add_item(
                    "utilities-terminal-symbolic",
                    "Inspect Element",
                    "Ctrl+Shift+I",
                    true,
                    Box::new(move || {
                        if let Some(settings) = WebViewExt::settings(&wv_insp) {
                            settings.set_enable_developer_extras(true);
                        }
                        if let Some(insp) = wv_insp.inspector() {
                            insp.show();
                        }
                    }),
                );

                menu.show_all();
                menu.popup_at_pointer(Some(event));
                true
            });
        });
    }

    let prev_active = *tab_state.active_tab_id.lock().unwrap();
    if let Some(prev_id) = prev_active {
        if prev_id != tab_id {
            schedule_tab_hibernation(&app, &tab_state, prev_id);
        }
    }

    *tab_state.active_tab_id.lock().unwrap() = Some(tab_id);
    apply_layout(&app, &tab_state);

    Ok(())
}

fn cancel_tab_hibernation(tab_state: &TabManagerState, tab_id: u64) {
    let mut gens = tab_state.tab_hide_gen.lock().unwrap();
    let next = gens.get(&tab_id).copied().unwrap_or(0).wrapping_add(1);
    gens.insert(tab_id, next);
}

#[cfg(target_os = "linux")]
fn schedule_tab_hibernation(app: &AppHandle, tab_state: &TabManagerState, tab_id: u64) {
    let gen = {
        let mut gens = tab_state.tab_hide_gen.lock().unwrap();
        let next = gens.get(&tab_id).copied().unwrap_or(0).wrapping_add(1);
        gens.insert(tab_id, next);
        next
    };

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20)).await;
        let app_main = app_clone.clone();
        let _ = app_clone.run_on_main_thread(move || {
            let Some(state) = app_main.try_state::<TabManagerState>() else {
                return;
            };
            if *state.active_tab_id.lock().unwrap() == Some(tab_id) {
                return;
            }
            if state.tab_hide_gen.lock().unwrap().get(&tab_id).copied() != Some(gen) {
                return;
            }
            if let Some(wv) = get_tab_webview(&app_main, tab_id) {
                let _ = wv.with_webview(move |platform_wv| {
                    use webkit2gtk::WebViewExt;
                    let wk = platform_wv.inner();
                    if !wk.is_playing_audio() {
                        wk.terminate_web_process();
                        if let Some(st) = app_main.try_state::<TabManagerState>() {
                            st.hibernated_tabs.lock().unwrap().insert(tab_id);
                        }
                    }
                });
            }
        });
    });
}

#[cfg(not(target_os = "linux"))]
fn schedule_tab_hibernation(_app: &AppHandle, _tab_state: &TabManagerState, _tab_id: u64) {}

#[tauri::command]
pub fn switch_tab_webview(
    app: AppHandle,
    _tab_state: State<'_, TabManagerState>,
    tab_id: u64,
    bounds: TabBounds,
) -> Result<(), String> {
    switch_tab_webview_inner(&app, tab_id, bounds)
}

pub fn switch_tab_webview_inner(
    app: &AppHandle,
    tab_id: u64,
    bounds: TabBounds,
) -> Result<(), String> {
    let tab_state = app
        .try_state::<TabManagerState>()
        .ok_or_else(|| "TabManagerState not found".to_string())?;
    if bounds.y > 20.0 {
        *tab_state.top_bar_height.lock().unwrap() = bounds.y;
    }

    cancel_tab_hibernation(&tab_state, tab_id);

    if let Some(prev_id) = *tab_state.active_tab_id.lock().unwrap() {
        if prev_id != tab_id {
            if let Some(prev_wv) = get_tab_webview(app, prev_id) {
                let _ = prev_wv.hide();
            }
            schedule_tab_hibernation(app, &tab_state, prev_id);
        }
    }

    *tab_state.active_tab_id.lock().unwrap() = Some(tab_id);
    apply_layout(app, &tab_state);

    let was_hibernated = tab_state.hibernated_tabs.lock().unwrap().remove(&tab_id);
    if let Some(wv) = get_tab_webview(app, tab_id) {
        if was_hibernated {
            #[cfg(target_os = "linux")]
            let _ = wv.with_webview(|platform_wv| {
                use webkit2gtk::WebViewExt;
                platform_wv.inner().reload();
            });
        }
        if !*tab_state.overlay_open.lock().unwrap() {
            let _ = wv.set_focus();
        }
    }

    Ok(())
}

#[cfg(target_os = "linux")]
pub fn go_back_tab(app: &AppHandle, tab_id: u64) {
    if let Some(wv) = get_tab_webview(app, tab_id) {
        let app_clone = app.clone();
        let _ = wv.with_webview(move |platform_wv| {
            use webkit2gtk::WebViewExt;
            let wk = platform_wv.inner();
            if wk.can_go_back() {
                wk.go_back();
            }
            let uri = wk.uri().map(|s| s.to_string()).unwrap_or_default();
            crate::gtk_ui::on_tab_uri_changed(
                &app_clone,
                tab_id,
                &uri,
                wk.can_go_back(),
                wk.can_go_forward(),
            );
        });
    }
}

#[cfg(target_os = "linux")]
pub fn go_forward_tab(app: &AppHandle, tab_id: u64) {
    if let Some(wv) = get_tab_webview(app, tab_id) {
        let app_clone = app.clone();
        let _ = wv.with_webview(move |platform_wv| {
            use webkit2gtk::WebViewExt;
            let wk = platform_wv.inner();
            if wk.can_go_forward() {
                wk.go_forward();
            }
            let uri = wk.uri().map(|s| s.to_string()).unwrap_or_default();
            crate::gtk_ui::on_tab_uri_changed(
                &app_clone,
                tab_id,
                &uri,
                wk.can_go_back(),
                wk.can_go_forward(),
            );
        });
    }
}

#[tauri::command]
pub fn close_tab_webview(
    app: AppHandle,
    _tab_state: State<'_, TabManagerState>,
    tab_id: u64,
) -> Result<(), String> {
    close_tab_webview_inner(&app, tab_id)
}

pub fn close_tab_webview_inner(app: &AppHandle, tab_id: u64) -> Result<(), String> {
    let tab_state = app
        .try_state::<TabManagerState>()
        .ok_or_else(|| "TabManagerState not found".to_string())?;
    cancel_tab_hibernation(&tab_state, tab_id);
    tab_state.hibernated_tabs.lock().unwrap().remove(&tab_id);
    tab_state.tab_hide_gen.lock().unwrap().remove(&tab_id);

    if let Some(wv) = get_tab_webview(app, tab_id) {
        #[cfg(target_os = "linux")]
        {
            let _ = wv.with_webview(|platform_wv| {
                use gtk::prelude::*;
                use webkit2gtk::WebViewExt;
                let wk = platform_wv.inner();
                wk.stop_loading();
                wk.terminate_web_process();
                if let Some(parent) = wk.parent() {
                    if let Ok(container) = parent.downcast::<gtk::Container>() {
                        container.remove(&wk);
                    }
                }
                unsafe {
                    wk.destroy();
                }
            });
            extern "C" {
                fn malloc_trim(pad: usize) -> i32;
            }
            unsafe {
                malloc_trim(0);
            }
        }
        let _ = wv.close();
    }
    let mut active = tab_state.active_tab_id.lock().unwrap();
    if *active == Some(tab_id) {
        *active = None;
    }
    Ok(())
}

#[tauri::command]
pub fn resize_tab_webview(
    app: AppHandle,
    tab_state: State<'_, TabManagerState>,
    bounds: TabBounds,
) -> Result<(), String> {
    if bounds.y > 20.0 {
        *tab_state.top_bar_height.lock().unwrap() = bounds.y;
    }
    apply_layout(&app, &tab_state);
    Ok(())
}

#[tauri::command]
pub fn set_overlay_visible(
    app: AppHandle,
    tab_state: State<'_, TabManagerState>,
    overlay_open: bool,
) -> Result<(), String> {
    set_overlay_only(&app, &tab_state, overlay_open);
    Ok(())
}

#[tauri::command]
pub fn open_overlay_panel(
    app: AppHandle,
    _tab_state: State<'_, TabManagerState>,
    panel: String,
    payload: Option<serde_json::Value>,
) -> Result<(), String> {
    open_overlay_panel_inner(&app, panel, payload)
}

pub fn open_overlay_panel_inner(
    app: &AppHandle,
    panel: String,
    payload: Option<serde_json::Value>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let _ = payload;
        crate::gtk_panels::open_native_panel(app, &panel);
        return Ok(());
    }

    #[cfg(not(target_os = "linux"))]
    {
        let tab_state = app
            .try_state::<TabManagerState>()
            .ok_or_else(|| "TabManagerState not found".to_string())?;
        if app.get_webview("overlay").is_none() {
            let main_window = app
                .get_window("main")
                .ok_or_else(|| "Main window not found".to_string())?;
            let top_bar_height = (*tab_state.top_bar_height.lock().unwrap()).max(40.0);
            let (win_w, win_h) = *tab_state.window_size.lock().unwrap();
            let content_h = (win_h - top_bar_height).max(100.0);
            let url_str = format!(
                "index.html?overlay=1&panel={}",
                url::form_urlencoded::byte_serialize(panel.as_bytes()).collect::<String>()
            );
            let overlay_wv = main_window
                .add_child(
                    WebviewBuilder::new("overlay", WebviewUrl::App(url_str.into())).transparent(true),
                    LogicalPosition::new(0.0, top_bar_height),
                    LogicalSize::new(win_w.max(100.0), content_h),
                )
                .map_err(|e| e.to_string())?;
            let _ = overlay_wv.hide();
            apply_layout(app, &tab_state);
        } else {
            let _ = app.emit(
                "overlay-open",
                serde_json::json!({ "panel": panel, "payload": payload }),
            );
        }
        Ok(())
    }
}

#[tauri::command]
pub fn reveal_overlay(
    app: AppHandle,
    tab_state: State<'_, TabManagerState>,
) -> Result<(), String> {
    set_overlay_only(&app, &tab_state, true);
    Ok(())
}

#[tauri::command]
pub fn close_overlay_panel(
    app: AppHandle,
    tab_state: State<'_, TabManagerState>,
) -> Result<(), String> {
    set_overlay_only(&app, &tab_state, false);
    if let Some(overlay_wv) = app.get_webview("overlay") {
        let _ = overlay_wv.close();
    }
    Ok(())
}

#[tauri::command]
pub fn navigate_tab(app: AppHandle, tab_id: u64, url: String) -> Result<(), String> {
    let wv = get_tab_webview(&app, tab_id).ok_or_else(|| "Tab webview not found".to_string())?;
    let target = if url == "newtab.html" || url.ends_with("/newtab.html") {
        if let Some(ui_wv) = app.get_webview("ui") {
            let mut base = ui_wv.url().map_err(|e| e.to_string())?;
            base.set_path("/newtab.html");
            base.set_query(None);
            base.set_fragment(None);
            base
        } else {
            #[cfg(target_os = "linux")]
            let base_str = app
                .try_state::<crate::gtk_ui::NativeUiState>()
                .and_then(|s| s.base_app_url.lock().unwrap().clone())
                .unwrap_or_else(|| "tauri://localhost/newtab.html".to_string());
            #[cfg(not(target_os = "linux"))]
            let base_str = "tauri://localhost/newtab.html".to_string();
            url::Url::parse(&base_str).map_err(|e| e.to_string())?
        }
    } else {
        url::Url::parse(&url).map_err(|e| e.to_string())?
    };

    let same_doc_hash_only = wv.url().ok().is_some_and(|cur| {
        cur.scheme() == target.scheme()
            && cur.host_str() == target.host_str()
            && cur.port() == target.port()
            && cur.path() == target.path()
            && cur.query() == target.query()
            && target.fragment().is_some()
    });

    #[cfg(target_os = "linux")]
    {
        let target_str = target.to_string();
        wv.with_webview(move |platform_wv| {
            use webkit2gtk::WebViewExt;
            let wk = platform_wv.inner();
            if !same_doc_hash_only {
                wk.stop_loading();
                wk.terminate_web_process();
            }
            wk.load_uri(&target_str);
        })
        .map_err(|e| e.to_string())?;
        extern "C" {
            fn malloc_trim(pad: usize) -> i32;
        }
        unsafe {
            malloc_trim(0);
        }
        return Ok(());
    }

    #[cfg(not(target_os = "linux"))]
    wv.navigate(target).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reload_tab(app: AppHandle, tab_id: u64) -> Result<(), String> {
    let wv = get_tab_webview(&app, tab_id).ok_or_else(|| "Tab webview not found".to_string())?;
    wv.eval("window.location.reload()").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn eval_tab_js(app: AppHandle, tab_id: u64, script: String) -> Result<(), String> {
    let wv = get_tab_webview(&app, tab_id).ok_or_else(|| "Tab webview not found".to_string())?;
    wv.eval(&script).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn print_tab(app: AppHandle, tab_id: u64) -> Result<(), String> {
    let wv = get_tab_webview(&app, tab_id).ok_or_else(|| "Tab webview not found".to_string())?;
    wv.print().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn toggle_devtools_tab(app: AppHandle, tab_id: u64) -> Result<(), String> {
    let wv = get_tab_webview(&app, tab_id).ok_or_else(|| "Tab webview not found".to_string())?;
    #[cfg(target_os = "linux")]
    let _ = wv.with_webview(|platform_wv| {
        use webkit2gtk::{SettingsExt, WebViewExt};
        if let Some(settings) = WebViewExt::settings(&platform_wv.inner()) {
            settings.set_enable_developer_extras(true);
        }
    });
    if wv.is_devtools_open() {
        wv.close_devtools();
    } else {
        wv.open_devtools();
    }
    Ok(())
}

#[tauri::command]
pub fn notify_context_menu(
    app: AppHandle,
    tab_state: State<'_, TabManagerState>,
    params: serde_json::Value,
) -> Result<(), String> {
    let tab_id = tab_state.active_tab_id.lock().unwrap().unwrap_or(1);
    let _ = app.emit(
        "tab-context-menu",
        serde_json::json!({ "tabId": tab_id, "params": params }),
    );
    Ok(())
}
