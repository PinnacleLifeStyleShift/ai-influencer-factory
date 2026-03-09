import { useState, useEffect, useCallback } from "react";
import * as api from "./api.js";
import {
  TrendingUp, Sparkles, ImageIcon, MessageSquare, Check, X, Calendar,
  ChevronRight, Loader2, RefreshCw, ThumbsUp, ThumbsDown, Send,
  Trash2, Eye, Zap, ArrowRight, Filter
} from "lucide-react";

// ─── STYLE HELPERS (matching App.jsx theme) ──────────────────
const css = {
  card: "bg-[#13131a] border border-[#2a2a3a] rounded-xl",
  input: "w-full bg-[#0d0d12] border border-[#2a2a3a] rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-[#C8FF00] transition-colors",
  label: "block text-[10px] font-semibold uppercase tracking-widest text-zinc-500 mb-1",
  btnVolt: "bg-[#C8FF00] text-black font-semibold text-sm px-4 py-2 rounded-lg hover:bg-[#d4ff33] transition-colors",
  btnGhost: "border border-[#2a2a3a] text-zinc-300 text-sm px-4 py-2 rounded-lg hover:border-[#C8FF00] hover:text-[#C8FF00] transition-colors",
  badge: "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium",
};

const STAGE_CONFIG = {
  draft: { label: "Draft", color: "#71717a", bg: "bg-zinc-700/30 text-zinc-400" },
  content_generated: { label: "Content Ready", color: "#60a5fa", bg: "bg-blue-500/10 text-blue-300" },
  review: { label: "In Review", color: "#fb923c", bg: "bg-orange-500/10 text-orange-300" },
  approved: { label: "Approved", color: "#4ade80", bg: "bg-green-500/10 text-green-300" },
  scheduled: { label: "Scheduled", color: "#C8FF00", bg: "bg-[#C8FF00]/10 text-[#C8FF00]" },
  published: { label: "Published", color: "#c084fc", bg: "bg-purple-500/10 text-purple-300" },
};

const STEPS = [
  { id: "trends", icon: TrendingUp, label: "Discover Trends" },
  { id: "script", icon: Sparkles, label: "Generate Script" },
  { id: "content", icon: ImageIcon, label: "Create Content" },
  { id: "caption", icon: MessageSquare, label: "Add Caption" },
  { id: "review", icon: Eye, label: "Review & Approve" },
];

// ─── PIPELINE PAGE ───────────────────────────────────────────
export default function PipelinePage({ characters }) {
  const [items, setItems] = useState([]);
  const [trends, setTrends] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeStep, setActiveStep] = useState("trends");
  const [stageFilter, setStageFilter] = useState("all");
  const [selectedItem, setSelectedItem] = useState(null);
  const [busy, setBusy] = useState(false);

  // Wizard state
  const [selectedCharacter, setSelectedCharacter] = useState("");
  const [selectedTrend, setSelectedTrend] = useState(null);
  const [generatedScript, setGeneratedScript] = useState(null);
  const [currentPipelineItem, setCurrentPipelineItem] = useState(null);

  // Discover options
  const [discoverPlatform, setDiscoverPlatform] = useState("TikTok");
  const [discoverNiche, setDiscoverNiche] = useState("Lifestyle");

  // Script options
  const [scriptTone, setScriptTone] = useState("casual");
  const [scriptContentType, setScriptContentType] = useState("tutorial");
  const [scriptDuration, setScriptDuration] = useState("30s");

  const load = useCallback(async () => {
    try {
      const [pipeItems, trendData] = await Promise.all([
        api.pipeline.list(),
        api.pipeline.listTrends(),
      ]);
      setItems(pipeItems);
      setTrends(trendData);
    } catch (err) {
      console.error("Pipeline load error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ─── Actions ─────────────────────────────────────
  const discoverTrends = async () => {
    setBusy(true);
    try {
      const result = await api.pipeline.discoverTrends({
        platform: discoverPlatform,
        niche: discoverNiche,
        count: 5,
        characterId: selectedCharacter || undefined,
      });
      setTrends(prev => [...result.trends, ...prev]);
    } catch (err) {
      console.error("Discover error:", err);
    } finally {
      setBusy(false);
    }
  };

  const generateScript = async () => {
    if (!selectedCharacter) return alert("Select a character first");
    setBusy(true);
    try {
      const result = await api.pipeline.generateScript({
        trendId: selectedTrend?.id,
        characterId: selectedCharacter,
        platform: discoverPlatform,
        duration: scriptDuration,
        tone: scriptTone,
        contentType: scriptContentType,
      });
      setGeneratedScript(result.script);
      setCurrentPipelineItem(result.pipelineItem);
      setActiveStep("content");
      await load();
    } catch (err) {
      console.error("Script gen error:", err);
    } finally {
      setBusy(false);
    }
  };

  const generateContent = async () => {
    if (!currentPipelineItem) return;
    setBusy(true);
    try {
      const result = await api.pipeline.generateContent({
        pipelineItemId: currentPipelineItem.id,
        type: "image",
      });
      setCurrentPipelineItem(result.pipelineItem);
      setActiveStep("caption");
      await load();
    } catch (err) {
      console.error("Content gen error:", err);
    } finally {
      setBusy(false);
    }
  };

  const generateCaption = async () => {
    if (!currentPipelineItem) return;
    setBusy(true);
    try {
      const result = await api.pipeline.generateCaption({
        pipelineItemId: currentPipelineItem.id,
        platform: discoverPlatform,
      });
      setCurrentPipelineItem(result.pipelineItem);
      setActiveStep("review");
      await load();
    } catch (err) {
      console.error("Caption gen error:", err);
    } finally {
      setBusy(false);
    }
  };

  const approveItem = async (id) => {
    setBusy(true);
    try {
      await api.pipeline.approve(id);
      await load();
      setSelectedItem(null);
    } catch (err) {
      console.error("Approve error:", err);
    } finally {
      setBusy(false);
    }
  };

  const rejectItem = async (id) => {
    setBusy(true);
    try {
      await api.pipeline.reject(id, { notes: "Needs revision" });
      await load();
      setSelectedItem(null);
    } catch (err) {
      console.error("Reject error:", err);
    } finally {
      setBusy(false);
    }
  };

  const scheduleItem = async (id) => {
    setBusy(true);
    try {
      const today = new Date().toISOString().split("T")[0];
      await api.pipeline.schedule(id, { scheduledDate: today, platform: discoverPlatform });
      await load();
      setSelectedItem(null);
    } catch (err) {
      console.error("Schedule error:", err);
    } finally {
      setBusy(false);
    }
  };

  const deleteItem = async (id) => {
    try {
      await api.pipeline.delete(id);
      await load();
      setSelectedItem(null);
    } catch (err) {
      console.error("Delete error:", err);
    }
  };

  // Reset wizard
  const resetWizard = () => {
    setActiveStep("trends");
    setSelectedTrend(null);
    setGeneratedScript(null);
    setCurrentPipelineItem(null);
  };

  // Stage counts
  const stageCounts = items.reduce((acc, it) => {
    acc[it.stage] = (acc[it.stage] || 0) + 1;
    return acc;
  }, {});

  const filteredItems = stageFilter === "all" ? items : items.filter(i => i.stage === stageFilter);

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <Loader2 className="animate-spin text-[#C8FF00]" size={32} />
    </div>
  );

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 style={{ fontFamily:"'Bebas Neue', sans-serif", letterSpacing:"0.1em" }} className="text-3xl text-zinc-100">
            Content Pipeline
          </h1>
          <p className="text-zinc-500 text-sm mt-1">Discover trends → Generate scripts → Create content → Approve & schedule</p>
        </div>
        <div className="flex gap-3">
          <button onClick={load} className={css.btnGhost}>
            <RefreshCw size={14} className="inline mr-2" />Refresh
          </button>
          <button onClick={resetWizard} className={css.btnVolt}>
            <Zap size={14} className="inline mr-2" />New Pipeline
          </button>
        </div>
      </div>

      {/* Stage Stats */}
      <div className="grid grid-cols-6 gap-3 mb-6">
        {Object.entries(STAGE_CONFIG).map(([key, cfg]) => (
          <button key={key} onClick={() => setStageFilter(stageFilter === key ? "all" : key)}
            className={`${css.card} p-3 text-center cursor-pointer transition-all ${stageFilter === key ? "border-[#C8FF00]" : "hover:border-[#3a3a4a]"}`}>
            <div className="text-2xl font-bold" style={{ color: cfg.color, fontFamily:"'Bebas Neue', sans-serif" }}>
              {stageCounts[key] || 0}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">{cfg.label}</div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* ─── LEFT: Wizard Panel ─────────────────────── */}
        <div className="col-span-5">
          <div className={`${css.card} overflow-hidden`}>
            {/* Step Indicators */}
            <div className="flex border-b border-[#2a2a3a]">
              {STEPS.map((step, i) => {
                const Icon = step.icon;
                const active = activeStep === step.id;
                const done = STEPS.findIndex(s => s.id === activeStep) > i;
                return (
                  <button key={step.id} onClick={() => setActiveStep(step.id)}
                    className={`flex-1 py-3 px-1 text-center border-b-2 transition-all ${
                      active ? "border-[#C8FF00] text-[#C8FF00]" : done ? "border-green-500 text-green-400" : "border-transparent text-zinc-600"
                    }`}>
                    <Icon size={14} className="mx-auto mb-1" />
                    <div className="text-[9px] uppercase tracking-wider">{step.label}</div>
                  </button>
                );
              })}
            </div>

            {/* Step Content */}
            <div className="p-4">
              {/* Character Selector (always visible) */}
              <div className="mb-4">
                <label className={css.label}>Character</label>
                <select value={selectedCharacter} onChange={e => setSelectedCharacter(e.target.value)} className={css.input}>
                  <option value="">Select a character...</option>
                  {characters.map(c => (
                    <option key={c.id} value={c.id}>{c.name} — {c.niche}</option>
                  ))}
                </select>
              </div>

              {/* STEP: Trends */}
              {activeStep === "trends" && (
                <div>
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className={css.label}>Platform</label>
                      <select value={discoverPlatform} onChange={e => setDiscoverPlatform(e.target.value)} className={css.input}>
                        <option>TikTok</option><option>Instagram</option><option>YouTube</option>
                      </select>
                    </div>
                    <div>
                      <label className={css.label}>Niche</label>
                      <select value={discoverNiche} onChange={e => setDiscoverNiche(e.target.value)} className={css.input}>
                        {["Lifestyle","Fashion","Beauty","Fitness","Tech","Food","Travel","Gaming"].map(n => (
                          <option key={n}>{n}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <button onClick={discoverTrends} disabled={busy} className={`${css.btnVolt} w-full mb-4`}>
                    {busy ? <Loader2 size={14} className="inline animate-spin mr-2" /> : <TrendingUp size={14} className="inline mr-2" />}
                    Discover Trends
                  </button>

                  {/* Trend List */}
                  <div className="space-y-2 max-h-[300px] overflow-y-auto">
                    {trends.length === 0 && <p className="text-zinc-600 text-sm text-center py-4">No trends yet. Click discover!</p>}
                    {trends.map(t => (
                      <button key={t.id} onClick={() => { setSelectedTrend(t); setActiveStep("script"); }}
                        className={`w-full text-left p-3 rounded-lg border transition-all ${
                          selectedTrend?.id === t.id ? "border-[#C8FF00] bg-[#C8FF00]/5" : "border-[#2a2a3a] hover:border-[#3a3a4a] bg-[#0d0d12]"
                        }`}>
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="text-sm text-zinc-200 font-medium">{t.topic}</div>
                            <div className="text-xs text-zinc-500 mt-1 line-clamp-2">{t.description}</div>
                          </div>
                          <div className="flex items-center gap-2 ml-2">
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#C8FF00]/10 text-[#C8FF00] font-medium">
                              {t.trendScore}%
                            </span>
                            <ChevronRight size={12} className="text-zinc-600" />
                          </div>
                        </div>
                        <div className="flex gap-1 mt-2">
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">{t.platform}</span>
                          {(t.hashtags || []).slice(0, 3).map((h, i) => (
                            <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500">{h}</span>
                          ))}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* STEP: Script */}
              {activeStep === "script" && (
                <div>
                  {selectedTrend && (
                    <div className="mb-3 p-3 rounded-lg bg-[#0d0d12] border border-[#2a2a3a]">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Selected Trend</div>
                      <div className="text-sm text-zinc-200">{selectedTrend.topic}</div>
                    </div>
                  )}
                  <div className="grid grid-cols-3 gap-3 mb-3">
                    <div>
                      <label className={css.label}>Tone</label>
                      <select value={scriptTone} onChange={e => setScriptTone(e.target.value)} className={css.input}>
                        {["casual","funny","educational","dramatic","inspirational"].map(t => (
                          <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className={css.label}>Type</label>
                      <select value={scriptContentType} onChange={e => setScriptContentType(e.target.value)} className={css.input}>
                        {["tutorial","story","challenge","review","dayInLife"].map(t => (
                          <option key={t} value={t}>{t === "dayInLife" ? "Day In Life" : t.charAt(0).toUpperCase() + t.slice(1)}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className={css.label}>Duration</label>
                      <select value={scriptDuration} onChange={e => setScriptDuration(e.target.value)} className={css.input}>
                        <option value="15s">15s</option><option value="30s">30s</option><option value="60s">60s</option>
                      </select>
                    </div>
                  </div>
                  <button onClick={generateScript} disabled={busy || !selectedCharacter} className={`${css.btnVolt} w-full mb-4`}>
                    {busy ? <Loader2 size={14} className="inline animate-spin mr-2" /> : <Sparkles size={14} className="inline mr-2" />}
                    Generate Script
                  </button>

                  {generatedScript && (
                    <div className="space-y-3">
                      <div className="p-3 rounded-lg bg-[#0d0d12] border border-[#2a2a3a]">
                        <div className="text-[10px] uppercase tracking-wider text-[#C8FF00] mb-1">Hook</div>
                        <div className="text-sm text-zinc-200">{generatedScript.hook}</div>
                      </div>
                      <div className="p-3 rounded-lg bg-[#0d0d12] border border-[#2a2a3a]">
                        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Script Body</div>
                        <div className="text-sm text-zinc-300 whitespace-pre-line">{generatedScript.body}</div>
                      </div>
                      <div className="p-3 rounded-lg bg-[#0d0d12] border border-[#2a2a3a]">
                        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Call to Action</div>
                        <div className="text-sm text-zinc-200">{generatedScript.callToAction}</div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* STEP: Content */}
              {activeStep === "content" && (
                <div>
                  {currentPipelineItem && (
                    <div className="mb-3 p-3 rounded-lg bg-[#0d0d12] border border-[#2a2a3a]">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Pipeline Item</div>
                      <div className="text-sm text-zinc-200">{generatedScript?.title || "Content"}</div>
                      <div className="text-xs text-zinc-500">{currentPipelineItem.stage}</div>
                    </div>
                  )}
                  <button onClick={generateContent} disabled={busy || !currentPipelineItem} className={`${css.btnVolt} w-full mb-4`}>
                    {busy ? <Loader2 size={14} className="inline animate-spin mr-2" /> : <ImageIcon size={14} className="inline mr-2" />}
                    Generate Image
                  </button>

                  {currentPipelineItem?.imageUrl && (
                    <div className="rounded-lg overflow-hidden border border-[#2a2a3a]">
                      <img src={currentPipelineItem.imageUrl} alt="Generated content" className="w-full" />
                    </div>
                  )}
                </div>
              )}

              {/* STEP: Caption */}
              {activeStep === "caption" && (
                <div>
                  <button onClick={generateCaption} disabled={busy || !currentPipelineItem} className={`${css.btnVolt} w-full mb-4`}>
                    {busy ? <Loader2 size={14} className="inline animate-spin mr-2" /> : <MessageSquare size={14} className="inline mr-2" />}
                    Generate Caption & Hashtags
                  </button>

                  {currentPipelineItem?.caption && (
                    <div className="space-y-3">
                      <div className="p-3 rounded-lg bg-[#0d0d12] border border-[#2a2a3a]">
                        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Caption</div>
                        <div className="text-sm text-zinc-200 whitespace-pre-line">{currentPipelineItem.caption}</div>
                      </div>
                      {currentPipelineItem.hashtags && (
                        <div className="p-3 rounded-lg bg-[#0d0d12] border border-[#2a2a3a]">
                          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Hashtags</div>
                          <div className="text-sm text-[#C8FF00]">{currentPipelineItem.hashtags}</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* STEP: Review */}
              {activeStep === "review" && currentPipelineItem && (
                <div>
                  <div className="space-y-3 mb-4">
                    {currentPipelineItem.imageUrl && (
                      <div className="rounded-lg overflow-hidden border border-[#2a2a3a]">
                        <img src={currentPipelineItem.imageUrl} alt="Content" className="w-full" />
                      </div>
                    )}
                    {currentPipelineItem.caption && (
                      <div className="p-3 rounded-lg bg-[#0d0d12] border border-[#2a2a3a]">
                        <div className="text-sm text-zinc-200 whitespace-pre-line">{currentPipelineItem.caption}</div>
                        {currentPipelineItem.hashtags && (
                          <div className="text-xs text-[#C8FF00] mt-2">{currentPipelineItem.hashtags}</div>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-3">
                    <button onClick={() => approveItem(currentPipelineItem.id)} disabled={busy}
                      className="flex-1 bg-green-600 text-white font-semibold text-sm px-4 py-2 rounded-lg hover:bg-green-500 transition-colors">
                      <ThumbsUp size={14} className="inline mr-2" />Approve
                    </button>
                    <button onClick={() => rejectItem(currentPipelineItem.id)} disabled={busy}
                      className="flex-1 bg-red-600/50 text-red-200 font-semibold text-sm px-4 py-2 rounded-lg hover:bg-red-600 transition-colors">
                      <ThumbsDown size={14} className="inline mr-2" />Reject
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ─── RIGHT: Pipeline Items List ─────────────── */}
        <div className="col-span-7">
          <div className={`${css.card} overflow-hidden`}>
            <div className="flex items-center justify-between p-4 border-b border-[#2a2a3a]">
              <h2 style={{ fontFamily:"'Bebas Neue', sans-serif", letterSpacing:"0.08em" }} className="text-lg text-zinc-100">
                Pipeline Items ({filteredItems.length})
              </h2>
              <div className="flex gap-2">
                <button onClick={() => setStageFilter("all")}
                  className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded ${stageFilter === "all" ? "bg-[#C8FF00]/10 text-[#C8FF00]" : "text-zinc-500 hover:text-zinc-300"}`}>
                  All
                </button>
                {Object.entries(STAGE_CONFIG).map(([key, cfg]) => (
                  <button key={key} onClick={() => setStageFilter(key)}
                    className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded ${stageFilter === key ? cfg.bg : "text-zinc-600 hover:text-zinc-400"}`}>
                    {cfg.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="divide-y divide-[#1e1e2a] max-h-[65vh] overflow-y-auto">
              {filteredItems.length === 0 && (
                <div className="p-8 text-center text-zinc-600">
                  <Zap size={32} className="mx-auto mb-3 opacity-30" />
                  <p className="text-sm">No pipeline items yet. Start by discovering trends!</p>
                </div>
              )}
              {filteredItems.map(item => {
                const stage = STAGE_CONFIG[item.stage] || STAGE_CONFIG.draft;
                return (
                  <div key={item.id} onClick={() => setSelectedItem(selectedItem?.id === item.id ? null : item)}
                    className={`p-4 cursor-pointer transition-all hover:bg-[#1a1a24] ${selectedItem?.id === item.id ? "bg-[#1a1a24]" : ""}`}>
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`${css.badge} ${stage.bg}`}>{stage.label}</span>
                          {item.platform && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">{item.platform}</span>
                          )}
                        </div>
                        <div className="text-sm text-zinc-200 font-medium">
                          {item.script?.title || `Pipeline Item`}
                        </div>
                        <div className="text-xs text-zinc-500 mt-1">
                          {item.character?.name || "Unknown"} • {new Date(item.createdAt).toLocaleDateString()}
                        </div>
                        {item.script?.hook && (
                          <div className="text-xs text-zinc-600 mt-1 italic line-clamp-1">"{item.script.hook}"</div>
                        )}
                      </div>
                      {item.imageUrl && (
                        <img src={item.imageUrl} alt="" className="w-12 h-12 rounded-lg object-cover ml-3 border border-[#2a2a3a]" />
                      )}
                    </div>

                    {/* Expanded Detail */}
                    {selectedItem?.id === item.id && (
                      <div className="mt-4 pt-4 border-t border-[#2a2a3a]">
                        {item.script && (
                          <div className="space-y-2 mb-3">
                            <div className="p-2 rounded bg-[#0d0d12] border border-[#1e1e2a]">
                              <div className="text-[9px] uppercase tracking-wider text-[#C8FF00] mb-0.5">Hook</div>
                              <div className="text-xs text-zinc-300">{item.script.hook}</div>
                            </div>
                            <div className="p-2 rounded bg-[#0d0d12] border border-[#1e1e2a]">
                              <div className="text-[9px] uppercase tracking-wider text-zinc-500 mb-0.5">Body</div>
                              <div className="text-xs text-zinc-400 whitespace-pre-line line-clamp-4">{item.script.body}</div>
                            </div>
                          </div>
                        )}
                        {item.imageUrl && (
                          <div className="mb-3 rounded-lg overflow-hidden border border-[#2a2a3a]">
                            <img src={item.imageUrl} alt="" className="w-full max-h-[200px] object-cover" />
                          </div>
                        )}
                        {item.caption && (
                          <div className="p-2 rounded bg-[#0d0d12] border border-[#1e1e2a] mb-3">
                            <div className="text-xs text-zinc-300 whitespace-pre-line">{item.caption}</div>
                            {item.hashtags && (
                              <div className="text-xs text-[#C8FF00] mt-1">{item.hashtags}</div>
                            )}
                          </div>
                        )}
                        <div className="flex gap-2">
                          {(item.stage === "review" || item.stage === "content_generated" || item.stage === "draft") && (
                            <>
                              <button onClick={(e) => { e.stopPropagation(); approveItem(item.id); }}
                                className="bg-green-600/80 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-green-500 transition-colors">
                                <ThumbsUp size={11} className="inline mr-1" />Approve
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); rejectItem(item.id); }}
                                className="bg-red-600/30 text-red-300 text-xs px-3 py-1.5 rounded-lg hover:bg-red-600/50 transition-colors">
                                <ThumbsDown size={11} className="inline mr-1" />Reject
                              </button>
                            </>
                          )}
                          {item.stage === "approved" && (
                            <button onClick={(e) => { e.stopPropagation(); scheduleItem(item.id); }}
                              className="bg-[#C8FF00] text-black text-xs px-3 py-1.5 rounded-lg hover:bg-[#d4ff33] font-semibold transition-colors">
                              <Calendar size={11} className="inline mr-1" />Schedule
                            </button>
                          )}
                          <button onClick={(e) => { e.stopPropagation(); deleteItem(item.id); }}
                            className="text-zinc-600 text-xs px-3 py-1.5 rounded-lg hover:bg-red-600/20 hover:text-red-400 transition-colors ml-auto">
                            <Trash2 size={11} className="inline mr-1" />Delete
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
