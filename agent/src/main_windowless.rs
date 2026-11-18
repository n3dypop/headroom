// Executable that runs in the background on Windows without a console window. With no arguments it runs `agent`.
#![windows_subsystem = "windows"]

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        args.push("agent".into());
    }
    std::process::exit(headroom::cli::run(args));
}
