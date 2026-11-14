#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        // Reduce glibc RSS fragmentation and return freed >=128KB buffers to the OS promptly.
        for (key, val) in [
            ("MALLOC_ARENA_MAX", "2"),
            ("MALLOC_MMAP_THRESHOLD_", "131072"),
            ("MALLOC_TRIM_THRESHOLD_", "131072"),
            ("G_SLICE", "always-malloc"),
        ] {
            if std::env::var_os(key).is_none() {
                unsafe {
                    std::env::set_var(key, val);
                }
            }
        }
    }

    forkit_lib::run()
}
