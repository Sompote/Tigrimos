import React, { useState, useEffect, useRef } from "react";
import * as Recharts from "recharts";

interface Props {
  src: string; // URL to the compiled .jsx.js file
}

export default function ReactComponentRenderer({ src }: Props) {
  const [Component, setComponent] = useState<React.ComponentType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    setError(null);
    setComponent(null);

    fetch(src)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
        return res.text();
      })
      .then((code) => {
        if (!mountedRef.current) return;

        // Strip the metadata comment line
        const jsCode = code.replace(/^\/\/ __REACT_META__=.*\n/, "");

        // Create a function that receives React and Recharts, returns the component
        const factory = new Function("React", "Recharts", jsCode);
        const Comp = factory(React, Recharts);

        if (Comp) {
          setComponent(() => Comp);
        } else {
          setError("No component returned from compiled code");
        }
      })
      .catch((err) => {
        if (mountedRef.current) setError(err.message);
      });

    return () => {
      mountedRef.current = false;
    };
  }, [src]);

  if (error) {
    return <div style={{ color: "#e53935", padding: 16, fontFamily: "monospace", whiteSpace: "pre-wrap", fontSize: 13 }}>Error: {error}</div>;
  }

  if (!Component) {
    return <div style={{ padding: 16, color: "#888" }}>Loading component...</div>;
  }

  return (
    <ErrorBoundary>
      <Component />
    </ErrorBoundary>
  );
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(err: Error) {
    return { error: err.message };
  }

  render() {
    if (this.state.error) {
      return <div style={{ color: "#e53935", padding: 16, fontFamily: "monospace", whiteSpace: "pre-wrap", fontSize: 13 }}>Runtime error: {this.state.error}</div>;
    }
    return this.props.children;
  }
}
