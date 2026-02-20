use wasmtime::component::{HasSelf, bindgen};
use wasmtime_wasi::WasiCtxView;

bindgen!({
    path: "./wit/smart_cms.wit",
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
    wasi: (wasmtime_wasi::WasiCtx, wasmtime_wasi::ResourceTable),
}

impl State {
    fn new() -> Self {
        Self {
            key_value: KeyValue::default(),
            wasi: (
                wasmtime_wasi::WasiCtx::default(),
                wasmtime_wasi::ResourceTable::default(),
            ),
        }
    }
}

impl wasmtime_wasi::WasiView for State {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi.0,
            table: &mut self.wasi.1,
        }
    }
}

impl Default for State {
    fn default() -> Self {
        Self::new()
    }
}

fn main() {
    let wasi_table = wasmtime_wasi::ResourceTable::new();
    let wasi_ctx = wasmtime_wasi::WasiCtxBuilder::new()
        .preopened_dir(
            ".",
            ".",
            wasmtime_wasi::DirPerms::READ,
            wasmtime_wasi::FilePerms::READ,
        )
        .unwrap()
        .build();

    let state = State {
        key_value: KeyValue::default(),
        wasi: (wasi_ctx, wasi_table),
    };

    let mut config = wasmtime::Config::default();
    config.wasm_component_model(true);

    let engine = wasmtime::Engine::new(&config).unwrap();
    let mut store = wasmtime::Store::new(&engine, state);

    let component =
        wasmtime::component::Component::from_file(&engine, "guest_with_ml.wasm").unwrap();
    let mut linker = wasmtime::component::Linker::new(&engine);
    wasmtime_wasi::p2::add_to_linker_sync(&mut linker).unwrap();
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
