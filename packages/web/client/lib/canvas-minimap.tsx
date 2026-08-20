import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
  type SetStateAction,
} from "react";

export type CanvasMinimapRegistration = {
  id: string;
  render: (chrome: CanvasMinimapChromeProps) => ReactNode;
};

export type CanvasMinimapChromeProps = {
  isCollapsed: boolean;
  onToggleCollapse: () => void;
};

const CanvasMinimapStateContext = createContext<CanvasMinimapRegistration | null>(null);
const CanvasMinimapDispatchContext = createContext<
  ((value: SetStateAction<CanvasMinimapRegistration | null>) => void) | null
>(null);

export function CanvasMinimapProvider({ children }: { children: ReactNode }) {
  const [registration, setRegistration] = useState<CanvasMinimapRegistration | null>(null);

  return (
    <CanvasMinimapStateContext.Provider value={registration}>
      <CanvasMinimapDispatchContext.Provider value={setRegistration}>
        {children}
      </CanvasMinimapDispatchContext.Provider>
    </CanvasMinimapStateContext.Provider>
  );
}

export function useCanvasMinimap(): CanvasMinimapRegistration | null {
  return useContext(CanvasMinimapStateContext);
}

export function useCanvasMinimapRegistration(
  registration: CanvasMinimapRegistration | null,
): void {
  const setRegistration = useContext(CanvasMinimapDispatchContext);

  useEffect(() => {
    if (!setRegistration) return;
    setRegistration(registration);
    return () => {
      setRegistration((current) =>
        current?.id === registration?.id ? null : current,
      );
    };
  }, [registration, setRegistration]);
}
