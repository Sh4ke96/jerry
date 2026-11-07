fn main() {
    // Declaring the app's commands makes each one need an explicit permission
    // (allow-<command>), which capabilities/default.json grants to the local pages only.
    let manifest = tauri_build::AppManifest::new().commands(&[
        "core_info",
        "start_core",
        "retry",
        "get_settings",
        "set_settings",
        "send_test_notification",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)).expect("failed to run the Tauri build script");
}
