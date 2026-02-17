use wasmtime::component::bindgen;
use wasmtime_wasi::WasiCtxView;

bindgen!({
    path: "../hello_world_wasi_guest/wit",
    world: "example",
});

struct State {
    wasi: wasmtime_wasi::WasiCtx,
    table: wasmtime_wasi::ResourceTable,
}

impl wasmtime_wasi::WasiView for State {
    fn ctx(&mut self) -> wasmtime_wasi::WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

fn main() {
    let mut config = wasmtime::Config::default();
    config.wasm_component_model(true);
    let engine = wasmtime::Engine::new(&config).unwrap();
    let mut linker = wasmtime::component::Linker::<State>::new(&engine);
    wasmtime_wasi::p2::add_to_linker_sync(&mut linker).unwrap();
    let wasi = wasmtime_wasi::WasiCtxBuilder::new()
        .inherit_stdout()
        .build();
    let mut store = wasmtime::Store::new(
        &engine,
        State {
            wasi,
            table: wasmtime_wasi::ResourceTable::new(),
        },
    );
    let component =
        wasmtime::component::Component::from_file(&engine, "../hello_world_wasi_guest/greet.wasm")
            .unwrap();
    let app = Example::instantiate(&mut store, &component, &linker).unwrap();
    app.call_greet(&mut store, "World").unwrap();
}
