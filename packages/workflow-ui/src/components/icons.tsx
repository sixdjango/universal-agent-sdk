import type { ReactNode } from 'react';

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const AgentIcon = () => (
  <Svg>
    <path d="M8 1.8l1.4 3.4 3.4 1.4-3.4 1.4L8 11.4 6.6 8 3.2 6.6l3.4-1.4z" />
    <path d="M12.5 10.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" />
  </Svg>
);
export const ReviewIcon = () => (
  <Svg>
    <path d="M8 1.8l5 2v3.6c0 3-2.1 5.4-5 6.8-2.9-1.4-5-3.8-5-6.8V3.8z" />
    <path d="M5.8 8l1.5 1.5 3-3" />
  </Svg>
);
export const ScriptIcon = () => (
  <Svg>
    <rect x="2" y="3" width="12" height="10" rx="2" />
    <path d="M5 7l2 1.5L5 10M8.5 10.5h2.5" />
  </Svg>
);
export const GateIcon = () => (
  <Svg>
    <path d="M8 2.2v1.3M8 12.5v1.3M3.4 8H2.2M13.8 8h-1.2" />
    <circle cx="8" cy="8" r="3.6" />
    <path d="M8 6.4V8l1 1" />
  </Svg>
);
export const SubflowIcon = () => (
  <Svg>
    <rect x="2" y="2.5" width="12" height="11" rx="2" />
    <rect x="5" y="6" width="6" height="4.5" rx="1" />
    <path d="M2 5h12" />
  </Svg>
);
export const LoopIcon = () => (
  <Svg>
    <path d="M12.5 6.2A4.8 4.8 0 0 0 3.6 5.4M3.5 9.8a4.8 4.8 0 0 0 8.9.8" />
    <path d="M3.4 2.8v2.8h2.8M12.6 13.2v-2.8H9.8" />
  </Svg>
);
export const ParallelIcon = () => (
  <Svg>
    <path d="M2.5 4h4.5l2 4-2 4H2.5M9 8h4.5M11.5 6l2 2-2 2" />
  </Svg>
);
export const InputsIcon = () => (
  <Svg>
    <path d="M9.5 2.5h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3M2.5 8h7M7 5.5L9.5 8 7 10.5" />
  </Svg>
);
export const OutputsIcon = () => (
  <Svg>
    <rect x="2.5" y="4.5" width="11" height="9" rx="1.5" />
    <path d="M5.5 4.5V3.5a2.5 2.5 0 0 1 5 0v1" />
  </Svg>
);
export const RerunIcon = () => (
  <Svg size={14}>
    <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.8v2.8h-2.8" />
  </Svg>
);
export const ForkIcon = () => (
  <Svg size={14}>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="4.5" cy="12.5" r="1.5" />
    <circle cx="11.5" cy="5.5" r="1.5" />
    <path d="M4.5 5v6M11.5 7c0 2.5-2 3-7 4" />
  </Svg>
);
export const CheckIcon = () => (
  <Svg size={14}>
    <path d="M3.5 8.5l3 3 6-7" />
  </Svg>
);
export const CloseIcon = () => (
  <Svg size={14}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);
