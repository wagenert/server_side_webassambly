use wasmtime::component::{HasSelf, bindgen};

bindgen!({
    path: "./smart_cms.wit",
    world: "app",
});

#[derive(Default)]
struct KeyValue {
    mem: std::collections::HashMap<String, String>,
}

impl component::smartcms::kvstore::Host for KeyValue {
    fn get(&mut self, key: String) -> Option<String> {
        self.mem.get(&key).cloned()
    }

    fn set(&mut self, key: String, value: String) {
        self.mem.insert(key, value);
    }
}

struct State {
    key_value: KeyValue,
}

impl State {
    fn new() -> Self {
        Self {
            key_value: KeyValue::default(),
        }
    }
}

impl Default for State {
    fn default() -> Self {
        Self::new()
    }
}

fn main() {
    let mut config = wasmtime::Config::default();
    config.wasm_component_model(true);

    let engine = wasmtime::Engine::new(&config).unwrap();
    let mut store = wasmtime::Store::new(&engine, State::new());

    let component = wasmtime::component::Component::from_file(&engine, "guest.wasm").unwrap();
    let mut linker = wasmtime::component::Linker::new(&engine);
    component::smartcms::kvstore::add_to_linker::<_, HasSelf<_>>(
        &mut linker,
        |state: &mut State| &mut state.key_value,
    )
    .unwrap();

    let app = App::instantiate(&mut store, &component, &linker);
    match app {
        Ok(app) => println!("{:?}", app.call_run(&mut store).unwrap()),
        Err(e) => {
            eprintln!("Error instantiating component: {e}");
        }
    }
}
