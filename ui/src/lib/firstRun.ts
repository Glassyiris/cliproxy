/** Small flags this browser keeps for the first-run card. Never keys. */
export const flag = {
  get: (k: string) => {
    try {
      return localStorage.getItem(`cook-router-${k}`);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(`cook-router-${k}`, v);
    } catch {}
  },
};
