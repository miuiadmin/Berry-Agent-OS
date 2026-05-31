import { create } from "zustand";
import { toast } from "sonner";
import {
  startDebugCapture,
  stopDebugCapture,
  type CaptureResult,
} from "@/lib/api";

interface DebugCaptureState {
  isCapturing: boolean;
  captureId: string | null;
  showResultDialog: boolean;
  lastResult: CaptureResult | null;
  loading: boolean;
}

interface DebugCaptureActions {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  dismissDialog: () => void;
}

export const useDebugCaptureStore = create<DebugCaptureState & DebugCaptureActions>((set) => ({
  isCapturing: false,
  captureId: null,
  showResultDialog: false,
  lastResult: null,
  loading: false,

  start: async () => {
    set({ loading: true });
    try {
      const res = await startDebugCapture();
      set({ isCapturing: true, captureId: res.captureId, loading: false });
      toast.success("Capture started");
    } catch (err) {
      set({ loading: false });
      toast.error(err instanceof Error ? err.message : "Failed to start capture");
    }
  },

  stop: async () => {
    set({ loading: true });
    try {
      const result = await stopDebugCapture();
      set({
        isCapturing: false,
        captureId: null,
        showResultDialog: true,
        lastResult: result,
        loading: false,
      });
    } catch (err) {
      set({ loading: false });
      toast.error(err instanceof Error ? err.message : "Failed to stop capture");
    }
  },

  dismissDialog: () => {
    set({ showResultDialog: false, lastResult: null });
  },
}));
