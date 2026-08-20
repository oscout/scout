function isBenignSocketReset(error) {
  return Boolean(
    error
      && typeof error === "object"
      && error.code === "ECONNRESET"
      && (error.syscall === "read" || error.syscall === "write")
  );
}

process.on("uncaughtException", (error) => {
  if (isBenignSocketReset(error)) {
    console.warn(`@openscout/web: ignored Vite client socket reset (${error.syscall}).`);
    return;
  }

  console.error(error);
  process.exit(1);
});
