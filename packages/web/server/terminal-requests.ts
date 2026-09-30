

export type TerminalRelayDestroyRequest = {
  sessionId?: string;
};

export type TerminalSurfaceControlRequest = {
  backend?: string;
  sessionName?: string;
  action?: string;
};
