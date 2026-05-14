
export const PerformanceMonitor = {
  timers: new Map<string, number>(),

  start(label: string) {
    this.timers.set(label, performance.now());
    console.log(`[Perf] START: ${label}`);
  },

  end(label: string) {
    const start = this.timers.get(label);
    if (start) {
      const duration = performance.now() - start;
      console.log(`[Perf] END: ${label} (${duration.toFixed(0)}ms)`);
      this.timers.delete(label);
    }
  },

  logEvent(name: string, data?: any) {
    console.log(`[Event] ${name}`, data || '');
  },

  logError(context: string, error: any) {
    console.error(`[Error] ${context}:`, error?.message || error);
  }
};
