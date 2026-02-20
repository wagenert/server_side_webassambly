use rand::RngExt;

mod bindings {
    use super::Component;
    wit_bindgen::generate!({ generate_all });
    export!(Component);
}
struct Component;

impl bindings::Guest for Component {
    #[allow(async_fn_in_trait)]
    fn storygen() -> String {
        let mut rng = rand::rng();
        let stories = std::fs::read_to_string("stories.txt").expect("Failed to read stories.txt");
        let lines = stories.lines().collect::<Vec<&str>>();
        let random_index = rng.random_range(0..lines.len());
        lines[random_index].to_string()
    }
}
