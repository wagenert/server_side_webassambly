mod bindgen {
    use super::Component;
    wit_bindgen::generate!({ generate_all });
    export!(Component);
}

struct Component;

impl bindgen::exports::wasi::cli::run::Guest for Component {
    fn run() -> Result<(), ()> {
        println!("Hello, world!");
        Ok(())
    }
}
