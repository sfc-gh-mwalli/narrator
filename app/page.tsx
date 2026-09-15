import { GpuCard } from "@/components/gpu-card"
import { EnrollPanel } from "@/components/enroll-panel"
import { GeneratePanel } from "@/components/generate-panel"

// Every page that touches Snowflake must opt out of static rendering.
export const dynamic = "force-dynamic"

export default function Home() {
  return (
    <main className="mx-auto max-w-4xl space-y-5 px-4 py-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Narrator</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Clone a voice from a short recording, then generate narration audio from
          a script.
        </p>
      </header>

      <GpuCard />
      <EnrollPanel />
      <GeneratePanel />
    </main>
  )
}
