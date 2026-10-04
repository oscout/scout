/** Shared room HTTP bounds. Leave envelope/cursor/membership headroom below transport cap. */
export const ROOM_LISTENING_RESPONSE_BYTES = 4 * 1024 * 1024;
export const ROOM_LISTENING_PAGE_BYTES = 3 * 1024 * 1024;
export const ROOM_LISTENING_MESSAGE_BYTES = 64 * 1024;
