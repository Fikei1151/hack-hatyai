import { Component, type ReactNode } from 'react';
import { useGame } from '../store';

/** If a game screen throws, say so politely instead of taking the whole page (and the 3D city) down. */
export class GameErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="pointer-events-auto absolute inset-0 z-50 grid place-items-center bg-[#0b2340]/35 p-4">
        <div className="glass w-[min(440px,94vw)] rounded-3xl p-5 text-center" role="alert">
          <div className="text-[40px]">😵</div>
          <h2 className="font-cute text-[18px] font-bold">เกมสะดุดนิดหน่อย</h2>
          <p className="mt-1 text-[12.5px] text-ink-2">มีบางอย่างผิดพลาดบนหน้าจอเกม (ข้อมูลเมืองและแบบจำลองยังปกติ)</p>
          <pre className="mt-2 max-h-24 overflow-auto rounded-lg bg-card p-2 text-left text-[11px] text-ink-3">{this.state.error.message}</pre>
          <div className="mt-3 flex justify-center gap-2">
            <button type="button" className="btn btn-primary rounded-xl px-5 py-2" onClick={() => this.setState({ error: null })}>
              ลองใหม่
            </button>
            <button
              type="button"
              className="btn rounded-xl px-5 py-2"
              onClick={() => {
                this.setState({ error: null });
                useGame.getState().close();
              }}
            >
              กลับโหมดจำลอง
            </button>
          </div>
        </div>
      </div>
    );
  }
}
