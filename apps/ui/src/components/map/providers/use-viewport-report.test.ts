import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useViewportReportEmitter } from './use-viewport-report';

const CENTER = { lat: 19, lng: 72 };
const CORNER = { lat: 19.1, lng: 72.1 };

describe('useViewportReportEmitter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emit debounces and reports center + half-diagonal radius after the delay', () => {
    const onViewportChange = vi.fn();
    const { result } = renderHook(() => useViewportReportEmitter(onViewportChange));

    act(() => {
      result.current.emit(CENTER, CORNER);
    });
    expect(onViewportChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onViewportChange).toHaveBeenCalledTimes(1);
    const viewport = onViewportChange.mock.calls[0][0];
    expect(viewport.lat).toBe(CENTER.lat);
    expect(viewport.lng).toBe(CENTER.lng);
    expect(viewport.radiusMeters).toBeGreaterThan(0);
  });

  it('emit omits zoom entirely when the caller does not pass one', () => {
    const onViewportChange = vi.fn();
    const { result } = renderHook(() => useViewportReportEmitter(onViewportChange));

    act(() => {
      result.current.emit(CENTER, CORNER);
      vi.advanceTimersByTime(300);
    });
    const viewport = onViewportChange.mock.calls[0][0];
    expect(viewport).not.toHaveProperty('zoom');
  });

  it('emit and emitNow thread the zoom level through to the reported viewport (#203 §7)', () => {
    const onViewportChange = vi.fn();
    const { result } = renderHook(() => useViewportReportEmitter(onViewportChange));

    act(() => {
      result.current.emit(CENTER, CORNER, 6);
      vi.advanceTimersByTime(300);
    });
    expect(onViewportChange.mock.calls[0][0].zoom).toBe(6);

    act(() => {
      result.current.emitNow(CENTER, CORNER, 11);
    });
    expect(onViewportChange.mock.calls[1][0].zoom).toBe(11);
  });

  it('emit collapses rapid successive calls into a single trailing emission', () => {
    const onViewportChange = vi.fn();
    const { result } = renderHook(() => useViewportReportEmitter(onViewportChange));

    act(() => {
      result.current.emit(CENTER, CORNER);
      vi.advanceTimersByTime(100);
      result.current.emit(CENTER, CORNER);
      vi.advanceTimersByTime(100);
      result.current.emit(CENTER, CORNER);
      vi.advanceTimersByTime(300);
    });

    expect(onViewportChange).toHaveBeenCalledTimes(1);
  });

  it('emitNow reports immediately, bypassing the debounce window', () => {
    const onViewportChange = vi.fn();
    const { result } = renderHook(() => useViewportReportEmitter(onViewportChange));

    act(() => {
      result.current.emitNow(CENTER, CORNER);
    });

    expect(onViewportChange).toHaveBeenCalledTimes(1);
    // No timer left pending — a later flush must not double-emit.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onViewportChange).toHaveBeenCalledTimes(1);
  });

  it('emitNow cancels a pending debounced emit so the trailing timer never double-fires', () => {
    const onViewportChange = vi.fn();
    const { result } = renderHook(() => useViewportReportEmitter(onViewportChange));

    act(() => {
      result.current.emit(CENTER, CORNER);
      result.current.emitNow(CENTER, CORNER);
    });
    expect(onViewportChange).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onViewportChange).toHaveBeenCalledTimes(1);
  });

  it('is a no-op (both emit and emitNow) when onViewportChange is undefined, as in the tourist app', () => {
    const { result } = renderHook(() => useViewportReportEmitter(undefined));

    expect(() => {
      act(() => {
        result.current.emit(CENTER, CORNER);
        result.current.emitNow(CENTER, CORNER);
        vi.advanceTimersByTime(300);
      });
    }).not.toThrow();
  });
});
