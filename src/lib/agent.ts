import { createAgent, registerTools } from '@ui-sdk/react/agent'

// The bridge between the page's ui-sdk components and an agent working in the
// reader's browser: it lists the controls and their values, and sets them.
export const agent = createAgent()

// In a browser with WebMCP, its own agent gets the bridge's tools. A control
// marked data-agent-confirm is left for the person to press.
const unregister = registerTools(agent, { allow: (step) => !step.confirm })
import.meta.hot?.dispose(unregister)
