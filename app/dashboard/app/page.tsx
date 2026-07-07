'use client'

import { useState } from 'react'
import { LeftSidebar } from '@/components/trading/left-sidebar'
import { CenterPanel } from '@/components/trading/center-panel'
import { AgentChat } from '@/components/trading/agent-chat'
import { BottomWorkbench } from '@/components/trading/bottom-workbench'
import { TerminalStatusBar } from '@/components/trading/terminal-status-bar'
import { cn } from '@/lib/utils'

export default function Page() {
  const [activeSymbol, setActiveSymbol] = useState('BTC/USDT')
  const [consoleCollapsed, setConsoleCollapsed] = useState(false)

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TerminalStatusBar />

      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className={cn(
            'grid min-h-0 flex-1 grid-cols-1',
            consoleCollapsed
              ? 'lg:grid-cols-[280px_minmax(0,1fr)_48px] xl:grid-cols-[300px_minmax(0,1fr)_48px]'
              : 'lg:grid-cols-[280px_minmax(0,1fr)_360px] xl:grid-cols-[300px_minmax(0,1fr)_390px]',
          )}
        >
          <div className="hidden min-h-0 border-r border-border lg:block">
            <LeftSidebar activeSymbol={activeSymbol} onSelect={setActiveSymbol} />
          </div>

          <main className="min-h-0 overflow-hidden">
            <CenterPanel activeSymbol={activeSymbol} />
          </main>

          <div className="hidden min-h-0 border-l border-border lg:block">
            <AgentChat collapsed={consoleCollapsed} onCollapsedChange={setConsoleCollapsed} />
          </div>
        </div>

        <BottomWorkbench />
      </div>
    </div>
  )
}
