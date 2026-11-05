use barochart_core::scene::OwnedScene;
use barochart_core::scene_parts::OwnedSceneCommands;
use barochart_js::json::{JsValue, JsonMode, parse_json};
use barochart_js::memory::{MemoryAccount, MemoryContext, OomStyle};
use barochart_js::string::JsString;

fn parse(source: &str) -> JsValue {
    parse_json(source.as_bytes(), JsonMode::Standard).unwrap()
}

fn scene_source() -> JsValue {
    parse(
        r##"{"width":320,"height":180,"background":"#000000","commands":[{"op":"lines","coords":[1,2,3,4],"color":"#ffffff"}],"layout":{},"stats":{"commandCount":1}}"##,
    )
}

fn overlay_source() -> JsValue {
    parse(r##"[{"op":"lines","coords":[5,6,7,8],"color":"#abcdef"}]"##)
}

fn owned_scene(context: &MemoryContext) -> OwnedScene {
    let mut scope = context.scope();
    let value = scene_source().try_clone_scoped(&mut scope).unwrap();
    OwnedScene::from_scoped(value, &mut scope).unwrap()
}

fn owned_overlay(context: &MemoryContext) -> OwnedSceneCommands {
    let mut scope = context.scope();
    let mut value = overlay_source().try_clone_scoped(&mut scope).unwrap();
    let JsValue::Array(commands) = &mut value else {
        panic!("overlay array")
    };
    OwnedSceneCommands::from_scoped(std::mem::take(commands), &mut scope).unwrap()
}

fn command_count(scene: &OwnedScene) -> usize {
    let JsValue::Object(scene) = scene.value() else {
        panic!("scene object")
    };
    let Some(JsValue::Array(commands)) = scene.get(&JsString::from_str("commands")) else {
        panic!("scene commands")
    };
    commands.len()
}

#[test]
fn owned_scene_absorbs_layer_groups_and_releases_on_drop() {
    let account = MemoryAccount::new(1 << 20, OomStyle::InternalErrorLowercase);
    let context = MemoryContext::accounted(&account);
    let mut scene = owned_scene(&context);
    let overlay = owned_overlay(&context);
    assert_eq!(
        account.snapshot().requested_live_bytes,
        scene.requested_bytes() + overlay.requested_bytes()
    );

    scene.append_commands(overlay).unwrap();
    assert_eq!(command_count(&scene), 2);
    assert_eq!(
        account.snapshot().requested_live_bytes,
        scene.requested_bytes()
    );
    drop(scene);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}

#[test]
fn denied_scene_merge_keeps_the_published_scene_and_drops_the_candidate() {
    let probe = MemoryAccount::new(0, OomStyle::InternalErrorLowercase);
    let probe_context = MemoryContext::accounted(&probe);
    let probe_scene = owned_scene(&probe_context);
    let probe_overlay = owned_overlay(&probe_context);
    let limit = probe_scene
        .requested_bytes()
        .checked_add(probe_overlay.requested_bytes())
        .unwrap();
    drop(probe_scene);
    drop(probe_overlay);
    assert_eq!(probe.snapshot().requested_live_bytes, 0);

    let account = MemoryAccount::new(limit, OomStyle::InternalErrorLowercase);
    let context = MemoryContext::accounted(&account);
    let mut scene = owned_scene(&context);
    let published_bytes = scene.requested_bytes();
    let overlay = owned_overlay(&context);
    let error = scene.append_commands(overlay).unwrap_err();
    assert_eq!(error.name, "InternalError");
    assert_eq!(error.message.to_string_lossy(), "out of memory");
    assert_eq!(command_count(&scene), 1);
    assert_eq!(account.snapshot().requested_live_bytes, published_bytes);
    drop(scene);
    assert_eq!(account.snapshot().requested_live_bytes, 0);
}
