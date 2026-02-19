use rand::RngExt;

pub fn storygen() -> String {
    let mut rng = rand::rng();
    let stories = std::fs::read_to_string("stories.txt").expect("Failed to read stories.txt");
    let lines = stories.lines().collect::<Vec<&str>>();
    let random_index = rng.random_range(0..lines.len());
    lines[random_index].to_string()
}
