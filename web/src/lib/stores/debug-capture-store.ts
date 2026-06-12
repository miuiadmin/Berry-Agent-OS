import { create } from "zustand";
import { toast } from "sonner";
import {
  startDebugCapture,
  stopDebugCapture,
  getDebugCaptureStatus,
  type CaptureResult,
} from "@/lib/api";
import { tOutside as t } from "@/lib/i18n";

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
  sync: () => Promise<void>;
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
      toast.success(t("debug.startCapturing"));
    } catch (err) {
      set({ loading: false });
      toast.error(err instanceof Error ? err.message : t("debug.startCapturing"));
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
      toast.error(err instanceof Error ? err.message : t("debug.stopCapturing"));
    }
  },

  sync: async () => {
    try {
      const status = await getDebugCaptureStatus();
      if (status.active) {
        set({ isCapturing: true, captureId: status.captureId ?? null });
      }
    } catch {}
  },

  dismissDialog: () => {
    set({ showResultDialog: false, lastResult: null });
  },
}));
