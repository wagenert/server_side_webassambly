use wasmcloud_component::{
    http,
    wasi::keyvalue::{atomics, store},
};

struct Component;

http::export!(Component);

impl http::Server for Component {
    fn handle(
        _request: http::IncomingRequest,
    ) -> http::Result<http::Response<impl http::OutgoingBody>> {
        let bucket = store::open("default").unwrap();
        let count = atomics::increment(&bucket, "counter", 1).unwrap();
        std::thread::sleep(std::time::Duration::from_secs(2));
        Ok(http::Response::new(format!(
            "Hello! I was called {} times!\n",
            count
        )))
    }
}
