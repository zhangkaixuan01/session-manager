fn main() {
    let roots = session_manager::storage::Roots::discover().expect("无法读取用户目录");
    let mut backend = session_manager::Backend::new(roots);
    for provider in [
        session_manager::model::Provider::Claude,
        session_manager::model::Provider::Codex,
    ] {
        let list = backend.list(provider);
        println!(
            "{:?}: {} sessions, {} running",
            provider,
            list.len(),
            list.iter().filter(|s| s.running).count()
        );
    }
}
