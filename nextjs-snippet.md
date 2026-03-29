// ═══════════════════════════════════════════════════════════════
// NEXT.JS TRADING BOT DASHBOARD - MAKE IT SEXY! 💅
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// OPTION 1: FULL NEXT.JS APP (Recommended for full features)
// ═══════════════════════════════════════════════════════════════

/\*
ARCHITECTURE:

┌─────────────────────────────────────────────────────────────┐
│ NEXT.JS FRONTEND │
│ ┌───────────────────────────────────────────────────────┐ │
│ │ Beautiful Dashboard (Port 3000) │ │
│ │ - Real-time charts │ │
│ │ - Position monitoring │ │
│ │ - Trade history │ │
│ │ - Weather display │ │
│ └───────────────────────────────────────────────────────┘ │
│ ↕ HTTP/WebSocket │
│ ┌───────────────────────────────────────────────────────┐ │
│ │ API Routes (Next.js API) │ │
│ │ /api/status - Bot status │ │
│ │ /api/positions - Current positions │ │
│ │ /api/history - Trade history │ │
│ │ /api/control - Start/Stop bot │ │
│ └───────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
↕
┌─────────────────────────────────────────────────────────────┐
│ YOUR TRADING BOT (Node.js) │
│ - Runs in background │
│ - Saves state to JSON files │
│ - Next.js reads the files │
└─────────────────────────────────────────────────────────────┘
\*/

// ═══════════════════════════════════════════════════════════════
// SETUP: Create Next.js App
// ═══════════════════════════════════════════════════════════════

/\*
Step 1: Create Next.js app

npx create-next-app@latest trading-dashboard
cd trading-dashboard

# Install dependencies

npm install recharts framer-motion lucide-react date-fns

# Install shadcn/ui (optional but makes it GORGEOUS)

npx shadcn-ui@latest init
npx shadcn-ui@latest add card button badge progress

\*/

// ═══════════════════════════════════════════════════════════════
// STEP 2: Create API Routes
// ═══════════════════════════════════════════════════════════════

// File: app/api/status/route.ts
import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
try {
// Read bot status from your state files
const stateFile = path.join(process.cwd(), '../data/signals/scanner-output.json');
const historyFile = path.join(process.cwd(), '../data/signals/trade-history.json');

    // Read current state
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));

    // Read trade history
    const history = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));

    return NextResponse.json({
      status: 'running',
      weather: state.weather || 'CLEAR',
      btcChange: state.btcChange24h || 0,
      tokensScanned: state.totalScanned || 0,
      signals: state.signals || [],
      totalTrades: history.totalTrades || 0,
      lastUpdate: state.lastUpdate || new Date().toISOString()
    });

} catch (error) {
return NextResponse.json({ error: 'Failed to read bot status' }, { status: 500 });
}
}

// File: app/api/positions/route.ts
export async function GET() {
try {
const positionsFile = path.join(process.cwd(), '../data/positions/current.json');
const positions = JSON.parse(fs.readFileSync(positionsFile, 'utf-8'));

    return NextResponse.json({
      positions: positions.active || [],
      totalValue: positions.totalValue || 0,
      unrealizedPnL: positions.unrealizedPnL || 0
    });

} catch (error) {
return NextResponse.json({ positions: [], totalValue: 0, unrealizedPnL: 0 });
}
}

// File: app/api/history/route.ts
export async function GET() {
try {
const historyFile = path.join(process.cwd(), '../data/signals/trade-history.json');
const history = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));

    return NextResponse.json({
      trades: history.history || [],
      totalTrades: history.totalTrades || 0,
      totalPnL: history.history?.reduce((sum, t) => sum + (t.pnl || 0), 0) || 0
    });

} catch (error) {
return NextResponse.json({ trades: [], totalTrades: 0, totalPnL: 0 });
}
}

// ═══════════════════════════════════════════════════════════════
// STEP 3: Create Beautiful Dashboard Components
// ═══════════════════════════════════════════════════════════════

// File: app/components/WeatherCard.tsx
'use client';

import { Cloud, Sun, CloudRain, Zap, Moon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface WeatherCardProps {
weather: 'CLEAR' | 'CLOUDY' | 'CLAUDE' | 'SHITTY' | 'STORMY' | 'FUCK_ME';
btcChange: number;
}

export function WeatherCard({ weather, btcChange }: WeatherCardProps) {
const weatherConfig = {
CLEAR: {
icon: Sun,
color: 'text-yellow-500',
bg: 'bg-yellow-500/10',
label: '☀️ CLEAR',
description: 'Perfect trading conditions'
},
CLOUDY: {
icon: Cloud,
color: 'text-gray-500',
bg: 'bg-gray-500/10',
label: '⛅ CLOUDY',
description: 'Trade carefully'
},
CLAUDE: {
icon: Zap,
color: 'text-purple-500',
bg: 'bg-purple-500/10',
label: '🤖 CLAUDE',
description: '50/50 - Coin flip territory'
},
SHITTY: {
icon: CloudRain,
color: 'text-orange-500',
bg: 'bg-orange-500/10',
label: '💩 SHITTY',
description: 'Poor conditions - skipping'
},
STORMY: {
icon: CloudRain,
color: 'text-red-500',
bg: 'bg-red-500/10',
label: '🌧️ STORMY',
description: 'Dangerous - hiding in hole'
},
FUCK_ME: {
icon: Moon,
color: 'text-blue-500',
bg: 'bg-blue-500/10',
label: '😴 SUNDAY',
description: 'Rest day - bot sleeping'
}
};

const config = weatherConfig[weather] || weatherConfig.CLEAR;
const Icon = config.icon;

return (
<Card className="relative overflow-hidden">
<div className={`absolute inset-0 ${config.bg} opacity-50`} />
<CardHeader className="relative">
<CardTitle className="flex items-center gap-2">
<Icon className={`h-6 w-6 ${config.color}`} />
Market Weather
</CardTitle>
</CardHeader>
<CardContent className="relative space-y-4">
<div>
<Badge className={`${config.bg} ${config.color} border-0`}>
{config.label}
</Badge>
<p className="text-sm text-muted-foreground mt-2">
{config.description}
</p>
</div>

        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">BTC 24h</span>
          <span className={`text-lg font-bold ${btcChange >= 0 ? 'text-green-500' : 'text-red-500'}`}>
            {btcChange >= 0 ? '+' : ''}{btcChange.toFixed(2)}%
          </span>
        </div>
      </CardContent>
    </Card>

);
}

// File: app/components/PositionCard.tsx
'use client';

import { TrendingUp, TrendingDown } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';

interface Position {
symbol: string;
side: 'LONG' | 'SHORT';
entryPrice: number;
currentPrice: number;
stopLoss: number;
takeProfit: number;
pnl: number;
pnlPercent: number;
}

export function PositionCard({ position }: { position: Position }) {
const isProfit = position.pnl >= 0;
const isLong = position.side === 'LONG';

// Calculate progress to TP
const range = position.takeProfit - position.entryPrice;
const progress = ((position.currentPrice - position.entryPrice) / range) \* 100;

return (
<Card className={`border-l-4 ${isProfit ? 'border-l-green-500' : 'border-l-red-500'}`}>
<CardHeader className="pb-3">
<div className="flex items-center justify-between">
<CardTitle className="text-lg font-bold">{position.symbol}</CardTitle>
<Badge variant={isLong ? 'default' : 'destructive'}>
{isLong ? '🚀 LONG' : '📉 SHORT'}
</Badge>
</div>
</CardHeader>
<CardContent className="space-y-4">
{/_ Current PnL _/}
<div className="flex items-center justify-between">
<span className="text-sm text-muted-foreground">Current PnL</span>
<div className="flex items-center gap-2">
{isProfit ? (
<TrendingUp className="h-4 w-4 text-green-500" />
) : (
<TrendingDown className="h-4 w-4 text-red-500" />
)}
<span className={`text-lg font-bold ${isProfit ? 'text-green-500' : 'text-red-500'}`}>
{isProfit ? '+' : ''}${position.pnl.toFixed(2)} ({position.pnlPercent.toFixed(1)}%)
</span>
</div>
</div>

        {/* Progress to TP */}
        <div className="space-y-2">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>SL ${position.stopLoss.toFixed(2)}</span>
            <span>Entry ${position.entryPrice.toFixed(2)}</span>
            <span>TP ${position.takeProfit.toFixed(2)}</span>
          </div>
          <Progress
            value={Math.max(0, Math.min(100, progress))}
            className="h-2"
          />
        </div>

        {/* Current Price */}
        <div className="flex items-center justify-between pt-2 border-t">
          <span className="text-sm text-muted-foreground">Current Price</span>
          <span className="text-lg font-mono">${position.currentPrice.toFixed(2)}</span>
        </div>
      </CardContent>
    </Card>

);
}

// File: app/components/TradeHistoryTable.tsx
'use client';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatDistance } from 'date-fns';

interface Trade {
symbol: string;
side: 'LONG' | 'SHORT';
pnl: number;
exitReason: string;
exitTime: string;
strategy: string;
}

export function TradeHistoryTable({ trades }: { trades: Trade[] }) {
return (
<div className="rounded-md border">
<Table>
<TableHeader>
<TableRow>
<TableHead>Symbol</TableHead>
<TableHead>Side</TableHead>
<TableHead>Strategy</TableHead>
<TableHead>PnL</TableHead>
<TableHead>Exit Reason</TableHead>
<TableHead>Time</TableHead>
</TableRow>
</TableHeader>
<TableBody>
{trades.map((trade, i) => (
<TableRow key={i}>
<TableCell className="font-medium">{trade.symbol}</TableCell>
<TableCell>
<Badge variant={trade.side === 'LONG' ? 'default' : 'destructive'}>
{trade.side}
</Badge>
</TableCell>
<TableCell className="text-sm text-muted-foreground">
{trade.strategy}
</TableCell>
<TableCell className={trade.pnl >= 0 ? 'text-green-500' : 'text-red-500'}>
{trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}
</TableCell>
<TableCell className="text-sm">{trade.exitReason}</TableCell>
<TableCell className="text-sm text-muted-foreground">
{formatDistance(new Date(trade.exitTime), new Date(), { addSuffix: true })}
</TableCell>
</TableRow>
))}
</TableBody>
</Table>
</div>
);
}

// File: app/components/StatsCard.tsx
'use client';

import { Card, CardContent } from '@/components/ui/card';
import { LucideIcon } from 'lucide-react';

interface StatsCardProps {
title: string;
value: string | number;
icon: LucideIcon;
trend?: {
value: number;
isPositive: boolean;
};
description?: string;
}

export function StatsCard({ title, value, icon: Icon, trend, description }: StatsCardProps) {
return (
<Card>
<CardContent className="p-6">
<div className="flex items-center justify-between">
<div className="space-y-1">
<p className="text-sm font-medium text-muted-foreground">{title}</p>
<p className="text-2xl font-bold">{value}</p>
{description && (
<p className="text-xs text-muted-foreground">{description}</p>
)}
</div>
<div className={`p-3 rounded-full ${trend?.isPositive ? 'bg-green-500/10' : 'bg-blue-500/10'}`}>
<Icon className={`h-6 w-6 ${trend?.isPositive ? 'text-green-500' : 'text-blue-500'}`} />
</div>
</div>
{trend && (
<div className={`mt-3 text-sm ${trend.isPositive ? 'text-green-500' : 'text-red-500'}`}>
{trend.isPositive ? '↑' : '↓'} {Math.abs(trend.value).toFixed(1)}% from yesterday
</div>
)}
</CardContent>
</Card>
);
}

// ═══════════════════════════════════════════════════════════════
// STEP 4: Create Main Dashboard Page
// ═══════════════════════════════════════════════════════════════

// File: app/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { WeatherCard } from './components/WeatherCard';
import { PositionCard } from './components/PositionCard';
import { TradeHistoryTable } from './components/TradeHistoryTable';
import { StatsCard } from './components/StatsCard';
import { Activity, TrendingUp, DollarSign, Target } from 'lucide-react';

export default function Dashboard() {
const [status, setStatus] = useState<any>(null);
const [positions, setPositions] = useState<any[]>([]);
const [history, setHistory] = useState<any[]>([]);

// Fetch data every 5 seconds
useEffect(() => {
const fetchData = async () => {
try {
const [statusRes, positionsRes, historyRes] = await Promise.all([
fetch('/api/status'),
fetch('/api/positions'),
fetch('/api/history')
]);

        setStatus(await statusRes.json());
        setPositions((await positionsRes.json()).positions);
        setHistory((await historyRes.json()).trades.slice(0, 10)); // Last 10 trades
      } catch (error) {
        console.error('Failed to fetch data:', error);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 5000);

    return () => clearInterval(interval);

}, []);

if (!status) {
return (
<div className="flex items-center justify-center min-h-screen">
<div className="text-center">
<div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary mx-auto" />
<p className="mt-4 text-muted-foreground">Loading dashboard...</p>
</div>
</div>
);
}

const totalPnL = history.reduce((sum, t) => sum + (t.pnl || 0), 0);
const winRate = history.length > 0
? (history.filter(t => t.pnl > 0).length / history.length) \* 100
: 0;

return (
<div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800">
<div className="container mx-auto p-6 space-y-6">
{/_ Header _/}
<div className="flex items-center justify-between">
<div>
<h1 className="text-4xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
🐍 Moray Eel Trading Bot
</h1>
<p className="text-muted-foreground mt-1">Premium Selective Trading Dashboard</p>
</div>
<div className="flex items-center gap-2">
<div className="h-3 w-3 rounded-full bg-green-500 animate-pulse" />
<span className="text-sm font-medium">Live</span>
</div>
</div>

        {/* Stats Grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <StatsCard
            title="Total PnL"
            value={`$${totalPnL.toFixed(2)}`}
            icon={DollarSign}
            trend={{ value: 12.5, isPositive: totalPnL >= 0 }}
          />
          <StatsCard
            title="Win Rate"
            value={`${winRate.toFixed(1)}%`}
            icon={Target}
            description={`${history.filter(t => t.pnl > 0).length}W / ${history.filter(t => t.pnl < 0).length}L`}
          />
          <StatsCard
            title="Active Positions"
            value={positions.length}
            icon={Activity}
            description="Currently trading"
          />
          <StatsCard
            title="Total Trades"
            value={history.length}
            icon={TrendingUp}
            description="All time"
          />
        </div>

        {/* Weather + Positions */}
        <div className="grid gap-6 md:grid-cols-3">
          {/* Weather Card */}
          <div className="md:col-span-1">
            <WeatherCard
              weather={status.weather}
              btcChange={status.btcChange}
            />
          </div>

          {/* Active Positions */}
          <div className="md:col-span-2 space-y-4">
            <h2 className="text-2xl font-bold">Active Positions</h2>
            {positions.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                No active positions
              </div>
            ) : (
              <div className="grid gap-4">
                {positions.map((pos, i) => (
                  <PositionCard key={i} position={pos} />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Trade History */}
        <div className="space-y-4">
          <h2 className="text-2xl font-bold">Recent Trades</h2>
          <TradeHistoryTable trades={history} />
        </div>
      </div>
    </div>

);
}

// ═══════════════════════════════════════════════════════════════
// STEP 5: Add Real-time Updates (Optional - WebSocket)
// ═══════════════════════════════════════════════════════════════

// For even better UX, add WebSocket for real-time updates:

// File: app/api/ws/route.ts
import { Server } from 'socket.io';

export function GET(req: Request) {
// Set up WebSocket server
// Push updates when bot state changes
// Client receives instant updates without polling
}

// File: app/components/RealtimeProvider.tsx
'use client';

import { useEffect } from 'react';
import io from 'socket.io-client';

export function RealtimeProvider({ children }) {
useEffect(() => {
const socket = io();

    socket.on('bot-update', (data) => {
      // Update dashboard in real-time
    });

    return () => socket.disconnect();

}, []);

return children;
}

// ═══════════════════════════════════════════════════════════════
// DEPLOYMENT
// ═══════════════════════════════════════════════════════════════

/\*
Development:
npm run dev

Production:
npm run build
npm start

Or deploy to Vercel:
vercel deploy
\*/
