import { useId } from 'react';
import { bodyLevel, num } from './format';

const PX_PER_M = 30;
const GROUND = 108;

/**
 * A little person next to a little house, with the simulated water drawn at true scale against
 * them (1.7 m person, 2.6 m storey), so "0.8 m" reads instantly as "up to the waist".
 */
export function WaterBuddy({ depth, maxDepth, place }: { depth: number; maxDepth: number; place: string }) {
  const clip = useId();
  const d = Math.max(0, Math.min(depth, 3.4));
  const top = GROUND - d * PX_PER_M;
  const mark = GROUND - Math.min(maxDepth, 3.4) * PX_PER_M;
  const body = bodyLevel(depth);
  const worried = depth >= 0.5;
  const wet = depth >= 0.05;
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-line bg-gradient-to-b from-[#eef7ff] to-white p-2.5">
      <svg width="132" height="124" viewBox="0 0 132 124" role="img" aria-label={`ระดับน้ำที่${place} ${num(depth, 2)} เมตร ถึง${body.text}`} className="flex-none">
        <defs>
          <clipPath id={clip}>
            <rect x="0" y={top} width="132" height={124 - top} />
          </clipPath>
        </defs>
        <circle cx="104" cy="22" r="11" fill={wet ? '#c9d6e3' : '#ffd66b'} />
        {!wet && <circle cx="104" cy="22" r="15" fill="#ffd66b" opacity="0.25" />}
        {/* house */}
        <g>
          <rect x="10" y={GROUND - 78} width="50" height="78" rx="3" fill="#fff7ea" stroke="#e8c79a" strokeWidth="2" />
          <path d={`M4 ${GROUND - 76} L35 ${GROUND - 100} L66 ${GROUND - 76} Z`} fill="#f4a261" stroke="#d9823f" strokeWidth="2" strokeLinejoin="round" />
          <rect x="18" y={GROUND - 66} width="13" height="13" rx="2" fill="#bfe0ff" stroke="#e8c79a" strokeWidth="1.5" />
          <rect x="39" y={GROUND - 66} width="13" height="13" rx="2" fill="#bfe0ff" stroke="#e8c79a" strokeWidth="1.5" />
          <rect x="26" y={GROUND - 32} width="16" height="32" rx="2" fill="#c98a5a" />
          <line x1="10" x2="60" y1={GROUND - 39} y2={GROUND - 39} stroke="#e8c79a" strokeWidth="1.5" strokeDasharray="3 3" />
        </g>
        {/* person, 1.7 m */}
        <g className={wet ? '' : 'bob'}>
          <rect x="83" y={GROUND - 36} width="14" height="20" rx="6" fill="#5b8def" />
          <rect x="84" y={GROUND - 17} width="5" height="17" rx="2.5" fill="#34495e" />
          <rect x="91" y={GROUND - 17} width="5" height="17" rx="2.5" fill="#34495e" />
          <rect x="78" y={GROUND - 34} width="5" height="14" rx="2.5" fill="#ffd2a6" transform={worried ? `rotate(-150 80 ${GROUND - 33})` : undefined} />
          <rect x="97" y={GROUND - 34} width="5" height="14" rx="2.5" fill="#ffd2a6" transform={worried ? `rotate(150 99 ${GROUND - 33})` : undefined} />
          <circle cx="90" cy={GROUND - 44} r="9" fill="#ffd2a6" />
          <circle cx="86.8" cy={GROUND - 45} r="1.3" fill="#2d3436" />
          <circle cx="93.2" cy={GROUND - 45} r="1.3" fill="#2d3436" />
          {worried ? (
            <ellipse cx="90" cy={GROUND - 40.5} rx="2" ry="1.6" fill="#2d3436" />
          ) : (
            <path d={`M87 ${GROUND - 41.5} Q90 ${GROUND - 38.5} 93 ${GROUND - 41.5}`} stroke="#2d3436" strokeWidth="1.3" fill="none" strokeLinecap="round" />
          )}
          <circle cx="84.5" cy={GROUND - 42} r="1.6" fill="#ff9aa2" opacity="0.7" />
          <circle cx="95.5" cy={GROUND - 42} r="1.6" fill="#ff9aa2" opacity="0.7" />
        </g>
        <rect x="0" y={GROUND} width="132" height={124 - GROUND} fill="#cfe3c4" />
        {/* highest water so far */}
        {maxDepth >= 0.1 && maxDepth > depth + 0.05 && (
          <line x1="2" x2="130" y1={mark} y2={mark} stroke="#7a5c3a" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.7" />
        )}
        {wet && (
          <g clipPath={`url(#${clip})`}>
            <rect x="0" y={top - 4} width="132" height={124} fill="#4f9be8" opacity="0.42" />
            <path
              className="wave"
              d={`M0 ${top} q10 -4 20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 V124 H0 Z`}
              fill="#3b82d6"
              opacity="0.35"
            />
          </g>
        )}
        {wet && <path className="wave" d={`M0 ${top} q10 -4 20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0`} stroke="#e9f4ff" strokeWidth="2" fill="none" />}
      </svg>
      <div className="min-w-0">
        <div className="truncate text-[11px] text-ink-3">น้ำที่ {place}</div>
        <div className="font-cute text-[24px] font-bold leading-tight">
          {wet ? `${num(depth, 2)} ม.` : 'แห้ง'} <span className="text-[20px]">{body.emoji}</span>
        </div>
        <div className="text-[12.5px] font-semibold text-ink-2">{wet ? `ท่วมถึง${body.text}` : 'ยังไม่มีน้ำท่วม'}</div>
        {maxDepth >= 0.1 && <div className="mt-0.5 text-[11px] text-ink-3">เคยสูงสุด {num(maxDepth, 2)} ม. (เส้นประ)</div>}
      </div>
    </div>
  );
}
