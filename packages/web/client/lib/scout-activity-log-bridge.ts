'use client';

import { useEffect, useRef } from 'react';
import { HObservabilityDefault } from '@hudsonkit';
import type { ApiConnectionState } from '../scout/Provider.tsx';
import type { ScoutStatusBarState } from '../scout/hooks.ts';

let observabilityBooted = false;

function ensureObservability() {
  if (observabilityBooted) return;
  observabilityBooted = true;
  HObservabilityDefault.setEnabled(true);
  HObservabilityDefault.logger.info('Scout web shell booted', { category: 'shell' });
}

/** Mirror connection/status pressure into the shared HudLogger buffer. */
export function useScoutActivityLogBridge(
  statusBar: ScoutStatusBarState,
  apiConnection: ApiConnectionState,
) {
  const lastOfflineMessage = useRef<string | null>(null);
  const lastStatusLabel = useRef<string | null>(null);
  const lastMeshValue = useRef<string | null>(null);

  useEffect(() => {
    ensureObservability();

    if (apiConnection.status === 'offline' || apiConnection.status === 'degraded') {
      const message = apiConnection.message?.trim() || 'Scout web API unreachable';
      if (message !== lastOfflineMessage.current) {
        lastOfflineMessage.current = message;
        HObservabilityDefault.logger.log(
          apiConnection.status === 'offline' ? 'error' : 'warn',
          message,
          { category: 'connection' },
        );
      }
    } else {
      lastOfflineMessage.current = null;
    }

    if (statusBar.status.color === 'red') {
      const label = statusBar.status.label.trim();
      if (label && label !== lastStatusLabel.current) {
        lastStatusLabel.current = label;
        HObservabilityDefault.logger.error(label, { category: 'status' });
      }
    } else {
      lastStatusLabel.current = null;
    }

    if (statusBar.mesh.color === 'amber' || statusBar.mesh.color === 'red') {
      const meshMessage = `${statusBar.mesh.label}: ${statusBar.mesh.value}`;
      if (meshMessage !== lastMeshValue.current) {
        lastMeshValue.current = meshMessage;
        const level = statusBar.mesh.color === 'red' ? 'error' : 'warn';
        HObservabilityDefault.logger.log(level, meshMessage, { category: 'mesh' });
      }
    } else {
      lastMeshValue.current = null;
    }
  }, [apiConnection.message, apiConnection.status, statusBar.mesh, statusBar.status]);
}
