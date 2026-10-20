export function createKeyedLockRegistry() {
  const activeKeys = new Set();
  return {
    acquire(key) {
      if (activeKeys.has(key)) return false;
      activeKeys.add(key);
      return true;
    },
    release(key) {
      activeKeys.delete(key);
    },
    has(key) {
      return activeKeys.has(key);
    }
  };
}

