import { create } from "zustand";

let counter = 0;

/**
 * Tiny toast bus. Operations that finish out of view - a queued migration, a
 * copied link, a failed rename - need to say so somewhere, and a dialog for
 * each would be worse than the silence it replaces.
 */
export const useToastStore = create((set, get) => ({
  toasts: [],

  push: (message, kind = "info") => {
    counter += 1;
    const id = counter;
    set((state) => ({ toasts: [...state.toasts, { id, message, kind }] }));
    setTimeout(() => get().dismiss(id), kind === "error" ? 6000 : 3500);
    return id;
  },

  dismiss: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  info: (message) => useToastStore.getState().push(message, "info"),
  success: (message) => useToastStore.getState().push(message, "success"),
  error: (message) => useToastStore.getState().push(message, "error"),
};
