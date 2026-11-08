/** Small flags this browser keeps for the first-run card. Never keys. */
export const flag = {
  get: (k: string) => {
    try {
      return localStorage.getItem(`cliproxy-${k}`);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(`cliproxy-${k}`, v);
    } catch {}
  },
};
