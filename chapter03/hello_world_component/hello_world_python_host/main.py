from wasmtime import Store, Engine
from wasmtime.component import Component, Linker

engine = Engine()
store = Store(engine)
component = Component.from_file(engine, "greet.wasm")
linker = Linker(engine)
greet = linker.instantiate(store,component) 
print(greet.greet(store, "World"))