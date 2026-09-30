import { getScoutWebPairingState, refreshScoutWebPairingState, type ScoutPairingState } from "./pairing.ts";

export async function loadPairingState(
  currentDirectory: string,
  refresh: boolean,
): Promise<ScoutPairingState> {
  return refresh
    ? refreshScoutWebPairingState(currentDirectory)
    : getScoutWebPairingState(currentDirectory);
}
