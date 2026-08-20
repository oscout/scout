fn main() -> std::process::ExitCode {
    match scoutd::repo_service::run_cli_from_env() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            std::process::ExitCode::from(1)
        }
    }
}
