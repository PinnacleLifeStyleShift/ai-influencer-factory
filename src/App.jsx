import { useState, useCallback, useEffect } from "react";
import * as api from "./api.js";
import {
  LayoutDashboard, Users, CalendarDays, Megaphone, Zap,
  Plus, X, Search, Trash2, ChevronLeft, ChevronRight,
  ArrowLeft, Video, TrendingUp, DollarSign, Eye, ExternalLink
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell
} from "recharts";

// ─── API → Frontend Field Normalizers ─────────────────────────
// The API returns camelCase; the UI components use snake_case
function normalizeChar(c) {
  return {
    id: c.id, character_id: c.characterId, name: c.name,
    character_type: c.characterType, niche: c.niche, persona: c.persona,
    gender: c.gender, ethnicity: c.ethnicity, eye_color: c.eyeColor, age: c.age,
    skin_conditions: c.skinConditions, advanced_features: c.advancedFeatures,
    optional_prompt: c.optionalPrompt, aspect_ratio: c.aspectRatio,
    quality_setting: c.qualitySetting, reference_image_url: c.referenceImageUrl,
    bopa_background: c.bopaBackground, bopa_outfit: c.bopaOutfit,
    bopa_poses: c.bopaPoses, bopa_angles: c.bopaAngles,
    target_platforms: c.targetPlatforms || [], status: c.status,
    follower_count: c.followerCount || 0, total_views: c.totalViews || 0,
    engagement_rate: c.engagementRate || "0.00", notes: c.notes,
  };
}
function normalizeContent(c) {
  return {
    id: c.id, character_id: c.characterId, character_name: c.character_name || c.character?.name || "",
    title: c.title, content_type: c.contentType, platform: c.platform,
    scheduled_date: c.scheduledDate, status: c.status, caption: c.caption,
    hashtags: c.hashtags, motion_prompt: c.motionPrompt,
    views: c.views || 0, likes: c.likes || 0, notes: c.notes,
  };
}
function normalizeCampaign(c) {
  return {
    id: c.id, name: c.name, brand: c.brand, platform: c.platform,
    brief: c.brief, requirements: c.requirements,
    payout_amount: c.payoutAmount, deadline: c.deadline, status: c.status,
    submissions: (c.submissions || []).map(s => ({
      id: s.id, character_id: s.characterId, character_name: s.character_name || s.character?.name || "",
      submission_url: s.submissionUrl, notes: s.notes, payout: s.payout || 0,
      status: s.status, submitted_at: s.submittedAt,
    })),
  };
}

// ─── CONSTANTS ────────────────────────────────────────────────
const TYPES = ["Human", "Mammal Hybrid", "Reptile Hybrid", "Alien / Sci-Fi", "Fantasy Creature"];
const NICHES = ["Fitness & Wellness", "Fashion & Beauty", "Travel & Lifestyle", "Gaming & Tech", "Food & Cooking", "Music & Dance", "Comedy & Entertainment", "Finance & Business"];
const PLATFORMS = ["TikTok", "Instagram", "YouTube"];
const GENDERS = ["Male", "Female", "Non-binary", "Trans"];
const ETHNICITIES = ["African", "Asian", "European", "Middle Eastern", "Mixed / Hybrid"];
const EYE_COLORS = ["Brown", "Blue", "Green", "Hazel", "Purple", "White", "Custom"];
const CONTENT_TYPES = ["Static Image", "Animated Video", "Motion Sync Video", "Behind-the-Scenes", "Character Lore"];
const TYPE_COLORS = { "Human": "#60a5fa", "Mammal Hybrid": "#fb923c", "Reptile Hybrid": "#4ade80", "Alien / Sci-Fi": "#c084fc", "Fantasy Creature": "#f472b6" };
const TYPE_DOT = { "Static Image": "#C8FF00", "Animated Video": "#FF3BFF", "Motion Sync Video": "#3BFFFF", "Behind-the-Scenes": "#fb923c", "Character Lore": "#c084fc" };
const STATUS_CLS = { published: "text-[#C8FF00] bg-[#C8FF00]/10", scheduled: "text-blue-300 bg-blue-500/10", draft: "text-zinc-500 bg-zinc-700/30", active: "text-[#C8FF00] bg-[#C8FF00]/10", closed: "text-zinc-500 bg-zinc-700/30" };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function uid() { return Math.random().toString(36).slice(2); }
function today() { return new Date().toISOString().split("T")[0]; }
function addDays(n) { return new Date(Date.now() + n * 86400000).toISOString().split("T")[0]; }

// ─── STYLE HELPERS ────────────────────────────────────────────
const css = {
  card: "bg-[#13131a] border border-[#2a2a3a] rounded-xl",
  input: "w-full bg-[#0d0d12] border border-[#2a2a3a] rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-[#C8FF00] transition-colors",
  label: "block text-[10px] font-semibold uppercase tracking-widest text-zinc-500 mb-1",
  btnVolt: "bg-[#C8FF00] text-black font-semibold text-sm px-4 py-2 rounded-lg hover:bg-[#d4ff33] transition-colors",
  btnGhost: "border border-[#2a2a3a] text-zinc-300 text-sm px-4 py-2 rounded-lg hover:border-[#C8FF00] hover:text-[#C8FF00] transition-colors",
  badge: "inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium",
};

// ─── SHARED COMPONENTS ───────────────────────────────────────
function Modal({ title, onClose, children, actions }) {
  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#13131a] border border-[#2a2a3a] rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-[#2a2a3a] flex-shrink-0">
          <h2 style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: "0.1em" }} className="text-xl text-zinc-100">{title}</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 transition-colors"><X size={18} /></button>
        </div>
        <div className="overflow-y-auto flex-1 p-5">{children}</div>
        {actions && <div className="flex justify-end gap-3 p-5 border-t border-[#2a2a3a] flex-shrink-0">{actions}</div>}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, volt }) {
  return (
    <div className={`${css.card} p-5`}>
      <div className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500 mb-2">{label}</div>
      <div style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: "0.08em" }} className={`text-3xl ${volt ? "text-[#C8FF00]" : "text-zinc-100"}`}>{value ?? "—"}</div>
      {sub && <div className="text-xs text-zinc-600 mt-1">{sub}</div>}
    </div>
  );
}

function Input({ label, ...props }) {
  return <div><label className={css.label}>{label}</label><input className={css.input} {...props} /></div>;
}

function Select({ label, options, ...props }) {
  return (
    <div>
      <label className={css.label}>{label}</label>
      <select className={css.input} {...props}>
        <option value="">Select...</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

function Textarea({ label, ...props }) {
  return <div><label className={css.label}>{label}</label><textarea className={`${css.input} resize-none`} {...props} /></div>;
}

// ─── DASHBOARD ────────────────────────────────────────────────
function Dashboard({ characters, content, campaigns }) {
  const published = content.filter(c => c.status === "published");
  const scheduled = content.filter(c => c.status === "scheduled");
  const activeCamps = campaigns.filter(c => c.status === "active");
  const totalEarned = campaigns.reduce((s, c) => s + (c.submissions || []).reduce((a, b) => a + parseFloat(b.payout || 0), 0), 0);

  const platformData = PLATFORMS.map(p => ({
    platform: p,
    views: content.filter(c => c.platform === p).reduce((s, c) => s + (c.views || 0), 0)
  })).filter(d => d.views > 0);

  const typeData = CONTENT_TYPES.map(t => ({ type: t, count: content.filter(c => c.content_type === t).length })).filter(d => d.count > 0);
  const totalContent = content.length || 1;
  const top = [...characters].sort((a, b) => (b.total_views || 0) - (a.total_views || 0)).slice(0, 5);

  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: "0.1em" }} className="text-4xl text-zinc-100">COMMAND CENTER</h1>
        <p className="text-zinc-500 text-sm mt-1">Portfolio overview & performance</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Characters" value={characters.length} sub={`${characters.filter(c=>c.status==="active").length} active`} volt />
        <StatCard label="Content" value={content.length} sub={`${published.length} published · ${scheduled.length} scheduled`} />
        <StatCard label="Active Campaigns" value={activeCamps.length} />
        <StatCard label="Total Earned" value={`$${totalEarned.toFixed(2)}`} sub="Higgsfield Earn" volt />
      </div>

      <div className="grid grid-cols-3 gap-5">
        <div className={`${css.card} p-5 col-span-2`}>
          <h2 style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: "0.1em" }} className="text-xl text-zinc-100 mb-4">PLATFORM VIEWS</h2>
          {platformData.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={platformData} barSize={40}>
                <XAxis dataKey="platform" tick={{ fill: "#71717a", fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#71717a", fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ background: "#13131a", border: "1px solid #2a2a3a", borderRadius: 8, color: "#f4f4f5", fontSize: 12 }} cursor={{ fill: "rgba(200,255,0,0.04)" }} />
                <Bar dataKey="views" radius={[4,4,0,0]}>
                  {platformData.map((_, i) => <Cell key={i} fill={i%2===0?"#C8FF00":"#FF3BFF"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : <div className="h-44 flex items-center justify-center text-zinc-600 text-sm">No published content yet</div>}
        </div>

        <div className={`${css.card} p-5`}>
          <h2 style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: "0.1em" }} className="text-xl text-zinc-100 mb-4">CONTENT MIX</h2>
          <div className="space-y-3">
            {typeData.length > 0 ? typeData.map((item, i) => (
              <div key={i}>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-zinc-300">{item.type}</span>
                  <span className="text-zinc-500 font-mono">{item.count}</span>
                </div>
                <div className="h-1.5 bg-[#1e1e2a] rounded-full overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${(item.count/totalContent)*100}%`, background: i%2===0?"#C8FF00":"#FF3BFF" }} />
                </div>
              </div>
            )) : <div className="text-zinc-600 text-sm">No content yet</div>}
          </div>
        </div>
      </div>

      <div className={`${css.card} p-5`}>
        <h2 style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: "0.1em" }} className="text-xl text-zinc-100 mb-4">TOP CHARACTERS</h2>
        {top.length === 0 ? <div className="text-zinc-600 text-sm py-6 text-center">No characters yet</div> : (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-[#2a2a3a]">
              {["Character","Niche","Followers","Views","Engagement"].map(h => (
                <th key={h} className="text-left pb-2 text-[10px] uppercase tracking-wider text-zinc-600 font-medium pr-4">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {top.map(c => (
                <tr key={c.id} className="border-b border-[#2a2a3a]/50 hover:bg-white/[0.02]">
                  <td className="py-3 pr-4"><span className="font-mono text-[11px] text-zinc-600 mr-2">{c.character_id}</span><span className="text-zinc-100">{c.name}</span></td>
                  <td className="py-3 pr-4 text-zinc-400">{c.niche || "—"}</td>
                  <td className="py-3 pr-4 font-mono text-zinc-300">{(c.follower_count||0).toLocaleString()}</td>
                  <td className="py-3 pr-4 font-mono text-zinc-300">{(c.total_views||0).toLocaleString()}</td>
                  <td className="py-3 font-mono text-[#C8FF00]">{c.engagement_rate||"0.00"}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── CHARACTERS ───────────────────────────────────────────────
const EMPTY_CHAR = { name:"",character_type:"",niche:"",persona:"",gender:"",ethnicity:"",eye_color:"",skin_conditions:"",age:"",advanced_features:"",optional_prompt:"",aspect_ratio:"9:16",quality_setting:"4K",reference_image_url:"",bopa_background:"",bopa_outfit:"",bopa_poses:"",bopa_angles:"",target_platforms:[],status:"active",follower_count:0,total_views:0,engagement_rate:"0.00",notes:"" };

function CharacterForm({ initial, onSave, onClose }) {
  const [f, setF] = useState(initial || EMPTY_CHAR);
  const set = (k,v) => setF(p=>({...p,[k]:v}));
  const togglePlat = p => set("target_platforms", f.target_platforms.includes(p) ? f.target_platforms.filter(x=>x!==p) : [...f.target_platforms,p]);

  const sections = [
    { title: "IDENTITY", fields: (
      <div className="grid grid-cols-3 gap-3">
        <Input label="Name *" value={f.name} onChange={e=>set("name",e.target.value)} placeholder="e.g. Veronica" />
        <Select label="Character Type *" value={f.character_type} onChange={e=>set("character_type",e.target.value)} options={TYPES} />
        <Select label="Niche" value={f.niche} onChange={e=>set("niche",e.target.value)} options={NICHES} />
      </div>
    )},
    { title: "APPEARANCE", fields: (
      <div className="grid grid-cols-4 gap-3">
        <Select label="Gender" value={f.gender} onChange={e=>set("gender",e.target.value)} options={GENDERS} />
        <Select label="Ethnicity" value={f.ethnicity} onChange={e=>set("ethnicity",e.target.value)} options={ETHNICITIES} />
        <Select label="Eye Color" value={f.eye_color} onChange={e=>set("eye_color",e.target.value)} options={EYE_COLORS} />
        <Input label="Age" value={f.age} onChange={e=>set("age",e.target.value)} placeholder="25 / Ageless" />
      </div>
    )},
    { title: "B-O-P-A FRAMEWORK", fields: (
      <div className="grid grid-cols-2 gap-3">
        {[["bopa_background","B — Background","Urban street, forest..."],["bopa_outfit","O — Outfit","Streetwear, luxury..."],["bopa_poses","P — Poses","Power stance, candid walk..."],["bopa_angles","A — Angles","Close-up, 3/4 body..."]].map(([k,l,p])=>(
          <Input key={k} label={l} value={f[k]} onChange={e=>set(k,e.target.value)} placeholder={p} />
        ))}
      </div>
    )},
  ];

  return (
    <Modal title={initial ? "EDIT CHARACTER" : "NEW CHARACTER"} onClose={onClose}
      actions={<><button onClick={onClose} className={css.btnGhost}>Cancel</button><button onClick={()=>onSave(f)} className={css.btnVolt}>{initial?"Save Changes":"Create"}</button></>}>
      <div className="space-y-5">
        {sections.map(({title,fields}) => (
          <div key={title}>
            <div className="text-[10px] font-semibold uppercase tracking-widest text-[#C8FF00] mb-3">{title}</div>
            {fields}
          </div>
        ))}
        <Textarea label="Persona / Backstory" value={f.persona} onChange={e=>set("persona",e.target.value)} rows={3} placeholder="Character personality and story..." />
        <div>
          <label className={css.label}>Skin Conditions & Advanced Features</label>
          <div className="grid grid-cols-2 gap-3">
            <Input label="" value={f.skin_conditions} onChange={e=>set("skin_conditions",e.target.value)} placeholder="Vitiligo, Scars..." />
            <Input label="" value={f.advanced_features} onChange={e=>set("advanced_features",e.target.value)} placeholder="Bioluminescent tattoos..." />
          </div>
        </div>
        <Textarea label="Optional Prompt" value={f.optional_prompt} onChange={e=>set("optional_prompt",e.target.value)} rows={2} placeholder='"Add bioluminescent tattoos along the arms..."' />
        <div className="grid grid-cols-3 gap-3">
          <Select label="Aspect Ratio" value={f.aspect_ratio} onChange={e=>set("aspect_ratio",e.target.value)} options={["9:16","1:1","16:9"]} />
          <Select label="Quality" value={f.quality_setting} onChange={e=>set("quality_setting",e.target.value)} options={["4K","1K"]} />
          <Input label="Reference Image URL" value={f.reference_image_url} onChange={e=>set("reference_image_url",e.target.value)} placeholder="https://..." />
        </div>
        <div>
          <label className={css.label}>Target Platforms</label>
          <div className="flex gap-2">
            {PLATFORMS.map(p=>(
              <button key={p} type="button" onClick={()=>togglePlat(p)} className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${f.target_platforms.includes(p)?"bg-[#C8FF00] text-black border-[#C8FF00]":"border-[#2a2a3a] text-zinc-400 hover:border-[#C8FF00]"}`}>{p}</button>
            ))}
          </div>
        </div>
        {initial && (
          <div className="grid grid-cols-3 gap-3">
            <Input label="Followers" type="number" value={f.follower_count} onChange={e=>set("follower_count",parseInt(e.target.value)||0)} />
            <Input label="Total Views" type="number" value={f.total_views} onChange={e=>set("total_views",parseInt(e.target.value)||0)} />
            <Input label="Engagement Rate %" value={f.engagement_rate} onChange={e=>set("engagement_rate",e.target.value)} />
          </div>
        )}
        <Textarea label="Notes" value={f.notes} onChange={e=>set("notes",e.target.value)} rows={2} />
      </div>
    </Modal>
  );
}

function Characters({ characters, setCharacters }) {
  const [modal, setModal] = useState(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [detail, setDetail] = useState(null);

  const filtered = characters.filter(c =>
    (!search || [c.name,c.niche,c.persona].some(v=>(v||"").toLowerCase().includes(search.toLowerCase()))) &&
    (!typeFilter || c.character_type === typeFilter)
  );

  const save = useCallback(async (form) => {
    try {
      if (modal?.id) {
        const updated = await api.characters.update(modal.id, form);
        setCharacters(cs => cs.map(c => c.id===modal.id ? normalizeChar(updated) : c));
      } else {
        const created = await api.characters.create(form);
        setCharacters(cs => [...cs, normalizeChar(created)]);
      }
      setModal(null);
    } catch (err) { console.error("Save character failed:", err); }
  }, [modal, setCharacters]);

  const del = async (id,name) => {
    if(!confirm(`Delete ${name}?`)) return;
    try {
      await api.characters.delete(id);
      setCharacters(cs=>cs.filter(c=>c.id!==id));
    } catch (err) { console.error("Delete character failed:", err); }
  };

  if (detail) {
    const c = characters.find(x=>x.id===detail);
    if (!c) { setDetail(null); return null; }
    return (
      <div className="p-8">
        <button onClick={()=>setDetail(null)} className="flex items-center gap-2 text-zinc-400 hover:text-zinc-100 mb-5 transition-colors text-sm"><ArrowLeft size={16}/> Back to Characters</button>
        <div className="flex items-start justify-between mb-6">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <span className="font-mono text-xs text-zinc-600">{c.character_id}</span>
              <span className={`${css.badge} ${STATUS_CLS[c.status]||""}`}>{c.status}</span>
            </div>
            <h1 style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: "0.1em" }} className="text-4xl text-zinc-100">{c.name.toUpperCase()}</h1>
            <p className="text-zinc-500 text-sm">{c.character_type} · {c.niche}</p>
          </div>
          <button onClick={()=>setModal(c)} className={css.btnGhost}>Edit</button>
        </div>

        <div className="grid grid-cols-4 gap-4 mb-6">
          {[["Followers",(c.follower_count||0).toLocaleString()],["Total Views",(c.total_views||0).toLocaleString()],["Engagement",`${c.engagement_rate||"0.00"}%`,true],["Platforms",(c.target_platforms||[]).join(", ")||"—"]].map(([l,v,volt])=>(
            <div key={l} className={`${css.card} p-4`}>
              <div className="text-[10px] uppercase tracking-widest text-zinc-600 mb-1">{l}</div>
              <div style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: "0.08em" }} className={`text-2xl ${volt?"text-[#C8FF00]":"text-zinc-100"}`}>{v}</div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-5">
          <div className={`${css.card} p-5`}>
            <h3 style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: "0.1em" }} className="text-lg text-zinc-100 mb-4">APPEARANCE</h3>
            <dl className="space-y-2">
              {[["Gender",c.gender],["Ethnicity",c.ethnicity],["Eye Color",c.eye_color],["Age",c.age],["Skin Conditions",c.skin_conditions],["Advanced Features",c.advanced_features]].filter(([,v])=>v).map(([k,v])=>(
                <div key={k} className="flex gap-2"><dt className="text-zinc-600 text-sm w-36 flex-shrink-0">{k}</dt><dd className="text-zinc-300 text-sm">{v}</dd></div>
              ))}
            </dl>
          </div>
          <div className={`${css.card} p-5`}>
            <h3 style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: "0.1em" }} className="text-lg text-zinc-100 mb-4">B-O-P-A FRAMEWORK</h3>
            <div className="space-y-3">
              {[["B — Background",c.bopa_background],["O — Outfit",c.bopa_outfit],["P — Poses",c.bopa_poses],["A — Angles",c.bopa_angles]].map(([l,v])=>(
                <div key={l} className="border border-[#2a2a3a] rounded-lg p-3">
                  <div className="text-[10px] font-semibold text-[#C8FF00] mb-1">{l}</div>
                  <div className="text-sm text-zinc-300">{v||<span className="text-zinc-600 italic">Not defined</span>}</div>
                </div>
              ))}
            </div>
          </div>
          {c.optional_prompt && (
            <div className={`${css.card} p-5 col-span-2`}>
              <h3 style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: "0.1em" }} className="text-lg text-zinc-100 mb-3">GENERATION PROMPT</h3>
              <div className="font-mono text-sm text-zinc-300 bg-[#0d0d12] rounded-lg p-3 border border-[#2a2a3a]">"{c.optional_prompt}"</div>
            </div>
          )}
          {c.persona && (
            <div className={`${css.card} p-5 col-span-2`}>
              <h3 style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: "0.1em" }} className="text-lg text-zinc-100 mb-3">PERSONA</h3>
              <p className="text-zinc-300 text-sm leading-relaxed">{c.persona}</p>
            </div>
          )}
        </div>
        {modal && <CharacterForm initial={modal?.id ? modal : null} onSave={save} onClose={()=>setModal(null)} />}
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: "0.1em" }} className="text-4xl text-zinc-100">CHARACTERS</h1>
          <p className="text-zinc-500 text-sm mt-1">{characters.length} influencers in portfolio</p>
        </div>
        <button onClick={()=>setModal("new")} className={`${css.btnVolt} flex items-center gap-2`}><Plus size={14}/> New Character</button>
      </div>

      <div className="flex gap-3 mb-6">
        <div className="relative flex-1 max-w-xs">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
          <input className={`${css.input} pl-9`} placeholder="Search characters..." value={search} onChange={e=>setSearch(e.target.value)} />
        </div>
        <select className={`${css.input} max-w-[160px]`} value={typeFilter} onChange={e=>setTypeFilter(e.target.value)}>
          <option value="">All types</option>
          {TYPES.map(t=><option key={t}>{t}</option>)}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center py-24 text-center">
          <Users size={32} className="text-zinc-700 mb-3" />
          <p className="text-zinc-500 mb-4">No characters yet</p>
          <button onClick={()=>setModal("new")} className={css.btnVolt}>Create First Character</button>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {filtered.map(c => (
            <div key={c.id} className={`${css.card} p-5 group hover:border-[#3a3a4a] transition-colors cursor-pointer`} onClick={()=>setDetail(c.id)}>
              <div className="flex items-start justify-between mb-3">
                <div>
                  <span className="font-mono text-[11px] text-zinc-600 block">{c.character_id}</span>
                  <h3 style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: "0.05em" }} className="text-xl text-zinc-100 leading-tight hover:text-[#C8FF00] transition-colors">{c.name}</h3>
                </div>
                <button onClick={e=>{e.stopPropagation();del(c.id,c.name);}} className="opacity-0 group-hover:opacity-100 p-1.5 text-zinc-600 hover:text-red-400 transition-all"><Trash2 size={13}/></button>
              </div>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {c.character_type && <span className={`${css.badge}`} style={{background:TYPE_COLORS[c.character_type]+"22",color:TYPE_COLORS[c.character_type]}}>{c.character_type}</span>}
                {c.niche && <span className={`${css.badge} bg-[#2a2a3a] text-zinc-400`}>{c.niche}</span>}
              </div>
              <div className="grid grid-cols-3 gap-2 pt-3 border-t border-[#2a2a3a]">
                {[["Followers",(c.follower_count||0).toLocaleString()],["Views",(c.total_views||0).toLocaleString()],["Engmt.",`${c.engagement_rate||"0"}%`]].map(([l,v],i)=>(
                  <div key={l} className="text-center">
                    <div className={`font-mono text-sm ${i===2?"text-[#C8FF00]":"text-zinc-200"}`}>{v}</div>
                    <div className="text-[10px] text-zinc-600">{l}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && <CharacterForm initial={modal==="new"?null:modal} onSave={save} onClose={()=>setModal(null)} />}
    </div>
  );
}

// ─── CONTENT CALENDAR ─────────────────────────────────────────
const EMPTY_CONTENT = { title:"",character_id:"",content_type:"",platform:"",scheduled_date:today(),status:"scheduled",caption:"",hashtags:"",motion_prompt:"",notes:"" };

function ContentCalendar({ content, setContent, characters }) {
  const [month, setMonth] = useState(new Date());
  const [selectedDay, setSelectedDay] = useState(null);
  const [modal, setModal] = useState(null);
  const [f, setF] = useState(EMPTY_CONTENT);
  const set = (k,v) => setF(p=>({...p,[k]:v}));

  const y = month.getFullYear(), m = month.getMonth();
  const firstDay = new Date(y,m,1).getDay();
  const daysInMonth = new Date(y,m+1,0).getDate();
  const days = Array.from({length:daysInMonth},(_,i)=>i+1);
  const getDateStr = d => `${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  const forDay = d => content.filter(c => c.scheduled_date === getDateStr(d));

  const todayD = new Date().getDate(), todayM = new Date().getMonth(), todayY = new Date().getFullYear();
  const isToday = d => d===todayD && m===todayM && y===todayY;

  const saveContent = async () => {
    if (!f.title || !f.character_id) return;
    try {
      const created = await api.content.create(f);
      setContent(cs=>[...cs, normalizeContent(created)]);
      setModal(null); setF(EMPTY_CONTENT);
    } catch (err) { console.error("Save content failed:", err); }
  };

  const selectedContent = selectedDay ? forDay(selectedDay) : [];

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: "0.1em" }} className="text-4xl text-zinc-100">CONTENT CALENDAR</h1>
          <p className="text-zinc-500 text-sm mt-1">{content.length} items scheduled</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <button onClick={()=>setMonth(new Date(y,m-1,1))} className={`${css.btnGhost} px-2.5 py-2`}><ChevronLeft size={14}/></button>
            <span style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: "0.1em" }} className="text-lg text-zinc-100 px-3">{MONTHS[m].toUpperCase()} {y}</span>
            <button onClick={()=>setMonth(new Date(y,m+1,1))} className={`${css.btnGhost} px-2.5 py-2`}><ChevronRight size={14}/></button>
          </div>
          <button onClick={()=>setModal(true)} className={`${css.btnVolt} flex items-center gap-2`}><Plus size={14}/>Schedule</button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-2 mb-2">
        {DAYS.map(d=><div key={d} className="text-center text-[10px] uppercase tracking-widest text-zinc-600 py-2">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-2">
        {Array.from({length:firstDay}).map((_,i)=><div key={`p${i}`}/>)}
        {days.map(d => {
          const dc = forDay(d);
          const sel = selectedDay===d;
          return (
            <div key={d} onClick={()=>setSelectedDay(sel?null:d)}
              className={`min-h-[80px] rounded-lg p-2 cursor-pointer border transition-all ${sel?"border-[#C8FF00] bg-[#C8FF00]/5":"border-[#2a2a3a] hover:border-[#3a3a4a] bg-[#13131a]"}`}>
              <div className={`text-xs font-mono mb-1.5 w-5 h-5 flex items-center justify-center rounded-full ${isToday(d)?"bg-[#C8FF00] text-black font-bold":"text-zinc-500"}`}>{d}</div>
              <div className="space-y-0.5">
                {dc.slice(0,3).map(c=>(
                  <div key={c.id} className="flex items-center gap-1">
                    <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{background:TYPE_DOT[c.content_type]||"#71717a"}}/>
                    <span className="text-[10px] text-zinc-400 truncate">{c.character_name}</span>
                  </div>
                ))}
                {dc.length>3&&<div className="text-[10px] text-zinc-600">+{dc.length-3}</div>}
              </div>
            </div>
          );
        })}
      </div>

      {selectedDay && selectedContent.length>0 && (
        <div className={`${css.card} mt-4 p-5`}>
          <h3 style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: "0.1em" }} className="text-xl text-zinc-100 mb-4">{MONTHS[m]} {selectedDay}</h3>
          <div className="space-y-2">
            {selectedContent.map(c=>(
              <div key={c.id} className="flex items-center gap-3 p-3 bg-[#0d0d12] rounded-lg border border-[#2a2a3a]">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{background:TYPE_DOT[c.content_type]||"#71717a"}}/>
                <div className="flex-1 min-w-0">
                  <div className="text-zinc-100 text-sm font-medium truncate">{c.title}</div>
                  <div className="text-zinc-600 text-xs">{c.character_name} · {c.platform} · <span className={STATUS_CLS[c.status]||""}>{c.status}</span></div>
                  {c.motion_prompt&&<div className="text-zinc-500 text-xs font-mono mt-0.5 truncate">"{c.motion_prompt}"</div>}
                </div>
                <div className="flex gap-2 text-xs">
                  {c.status==="scheduled"&&<button onClick={async()=>{try{const u=await api.content.update(c.id,{status:"published"});setContent(cs=>cs.map(x=>x.id===c.id?normalizeContent(u):x));}catch(e){console.error(e);}}} className="text-[#C8FF00] hover:underline">Publish</button>}
                  <button onClick={async()=>{try{await api.content.delete(c.id);setContent(cs=>cs.filter(x=>x.id!==c.id));}catch(e){console.error(e);}}} className="text-red-400 hover:underline">Delete</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-4 mt-4">
        {Object.entries(TYPE_DOT).map(([type,col])=>(
          <div key={type} className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full" style={{background:col}}/>
            <span className="text-[11px] text-zinc-600">{type}</span>
          </div>
        ))}
      </div>

      {modal && (
        <Modal title="SCHEDULE CONTENT" onClose={()=>{setModal(null);setF(EMPTY_CONTENT);}}
          actions={<><button onClick={()=>{setModal(null);setF(EMPTY_CONTENT);}} className={css.btnGhost}>Cancel</button><button onClick={saveContent} className={css.btnVolt}>Schedule</button></>}>
          <div className="space-y-3">
            <div>
              <label className={css.label}>Character *</label>
              <select className={css.input} value={f.character_id} onChange={e=>set("character_id",e.target.value)}>
                <option value="">Select character</option>
                {characters.map(c=><option key={c.id} value={c.id}>{c.character_id} — {c.name}</option>)}
              </select>
            </div>
            <Input label="Title *" value={f.title} onChange={e=>set("title",e.target.value)} placeholder="Content title..." />
            <div className="grid grid-cols-2 gap-3">
              <Select label="Content Type" value={f.content_type} onChange={e=>set("content_type",e.target.value)} options={CONTENT_TYPES} />
              <Select label="Platform" value={f.platform} onChange={e=>set("platform",e.target.value)} options={PLATFORMS} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Date" type="date" value={f.scheduled_date} onChange={e=>set("scheduled_date",e.target.value)} />
              <div>
                <label className={css.label}>Status</label>
                <select className={css.input} value={f.status} onChange={e=>set("status",e.target.value)}>
                  {["draft","scheduled","published"].map(s=><option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
            <Textarea label="Motion Prompt" value={f.motion_prompt} onChange={e=>set("motion_prompt",e.target.value)} rows={2} placeholder='"Character walks confidently toward camera..."' />
            <Textarea label="Caption" value={f.caption} onChange={e=>set("caption",e.target.value)} rows={2} />
            <Input label="Hashtags" value={f.hashtags} onChange={e=>set("hashtags",e.target.value)} placeholder="#ai #influencer..." />
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── CAMPAIGNS ────────────────────────────────────────────────
const EMPTY_CAMP = { name:"",brand:"",platform:"",brief:"",requirements:"",payout_amount:"",deadline:"",status:"active",submissions:[] };

function Campaigns({ campaigns, setCampaigns, characters }) {
  const [modal, setModal] = useState(null);
  const [submitModal, setSubmitModal] = useState(null);
  const [subForm, setSubForm] = useState({character_id:"",submission_url:"",notes:""});
  const [campForm, setCampForm] = useState(EMPTY_CAMP);
  const setC = (k,v) => setCampForm(p=>({...p,[k]:v}));

  const saveCampaign = async () => {
    if(!campForm.name) return;
    try {
      if(modal?.id) {
        const updated = await api.campaigns.update(modal.id, campForm);
        setCampaigns(cs=>cs.map(c=>c.id===modal.id?normalizeCampaign(updated):c));
      } else {
        const created = await api.campaigns.create(campForm);
        setCampaigns(cs=>[...cs, normalizeCampaign(created)]);
      }
      setModal(null); setCampForm(EMPTY_CAMP);
    } catch(err) { console.error("Save campaign failed:", err); }
  };

  const submit = async () => {
    if(!subForm.character_id) return;
    try {
      await api.campaigns.submit(submitModal.id, subForm);
      // Refresh campaigns to get updated submissions
      const allCamps = await api.campaigns.list();
      setCampaigns(allCamps.map(normalizeCampaign));
      setSubmitModal(null); setSubForm({character_id:"",submission_url:"",notes:""});
    } catch(err) { console.error("Submit failed:", err); }
  };

  const totalEarned = campaigns.reduce((s,c)=>s+(c.submissions||[]).reduce((a,b)=>a+parseFloat(b.payout||0),0),0);
  const totalSubs = campaigns.reduce((s,c)=>s+(c.submissions||[]).length,0);
  const daysLeft = d => { if(!d) return null; const diff=Math.ceil((new Date(d)-new Date())/(1000*60*60*24)); return diff; };

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: "0.1em" }} className="text-4xl text-zinc-100">CAMPAIGNS</h1>
          <p className="text-zinc-500 text-sm mt-1">{campaigns.filter(c=>c.status==="active").length} active · ${totalEarned.toFixed(2)} earned</p>
        </div>
        <div className="flex gap-3">
          <a href="https://higgsfield.ai" target="_blank" rel="noreferrer" className={`${css.btnGhost} flex items-center gap-2`}><ExternalLink size={13}/>Higgsfield Earn</a>
          <button onClick={()=>{setCampForm(EMPTY_CAMP);setModal("new");}} className={`${css.btnVolt} flex items-center gap-2`}><Plus size={14}/>New Campaign</button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <StatCard label="Active Campaigns" value={campaigns.filter(c=>c.status==="active").length} />
        <StatCard label="Total Submissions" value={totalSubs} />
        <StatCard label="Total Earned" value={`$${totalEarned.toFixed(2)}`} volt />
      </div>

      {campaigns.length===0 ? (
        <div className="flex flex-col items-center py-24 text-center">
          <DollarSign size={32} className="text-zinc-700 mb-3"/>
          <p className="text-zinc-500 mb-4">No campaigns yet</p>
          <button onClick={()=>setModal("new")} className={css.btnVolt}>Add First Campaign</button>
        </div>
      ) : (
        <div className="space-y-3">
          {campaigns.map(c=>{
            const dl = daysLeft(c.deadline);
            const dlCls = dl===null?"":dl<0?"text-red-400":dl<=3?"text-orange-400":dl<=7?"text-yellow-400":"text-zinc-500";
            return (
              <div key={c.id} className={`${css.card} p-5`}>
                <div className="flex items-start gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <h3 className="text-zinc-100 font-semibold">{c.name}</h3>
                      {c.brand&&<span className="text-zinc-500 text-sm">{c.brand}</span>}
                      <span className={`${css.badge} ${STATUS_CLS[c.status]||""}`}>{c.status}</span>
                      {c.platform&&<span className={`${css.badge} bg-[#2a2a3a] text-zinc-400`}>{c.platform}</span>}
                    </div>
                    {c.brief&&<p className="text-zinc-500 text-sm line-clamp-2 mb-2">{c.brief}</p>}
                    {(c.submissions||[]).length>0&&(
                      <div className="flex flex-wrap gap-2 mt-2">
                        {(c.submissions||[]).map(s=>(
                          <span key={s.id} className="text-xs bg-[#2a2a3a] text-zinc-400 px-2 py-0.5 rounded">{s.character_name}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-5 text-sm flex-shrink-0">
                    {c.payout_amount&&<div className="text-center"><div className="font-mono text-[#C8FF00]">${parseFloat(c.payout_amount).toFixed(2)}</div><div className="text-[10px] text-zinc-600">payout</div></div>}
                    <div className="text-center"><div className="font-mono text-zinc-200">{(c.submissions||[]).length}</div><div className="text-[10px] text-zinc-600">submissions</div></div>
                    {c.deadline&&<div className="text-center"><div className={`font-mono text-xs ${dlCls}`}>{dl<0?"Expired":`${dl}d left`}</div><div className="text-[10px] text-zinc-600">{c.deadline}</div></div>}
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    {c.status==="active"&&<button onClick={()=>setSubmitModal(c)} className={css.btnVolt+" text-xs"}>Submit Character</button>}
                    <button onClick={()=>{setCampForm({...c});setModal(c);}} className={`${css.btnGhost} text-xs`}>Edit</button>
                    <button onClick={async()=>{if(confirm("Delete?")){try{await api.campaigns.delete(c.id);setCampaigns(cs=>cs.filter(x=>x.id!==c.id));}catch(e){console.error(e);}}}} className={`${css.btnGhost} text-xs text-red-400 border-red-400/20 hover:border-red-400`}>Delete</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-5 p-4 rounded-xl border border-[#2a2a3a] bg-[#13131a]/50">
        <p className="text-xs text-zinc-600"><span className="text-zinc-400 font-medium">FTC Compliance:</span> All sponsored content must include paid promotion disclosure. Instagram: "Paid Partnership" label. YouTube: "Includes paid promotion" checkbox.</p>
      </div>

      {modal && (
        <Modal title={modal==="new"?"NEW CAMPAIGN":"EDIT CAMPAIGN"} onClose={()=>setModal(null)}
          actions={<><button onClick={()=>setModal(null)} className={css.btnGhost}>Cancel</button><button onClick={saveCampaign} className={css.btnVolt}>Save</button></>}>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Input label="Campaign Name *" value={campForm.name} onChange={e=>setC("name",e.target.value)} />
              <Input label="Brand" value={campForm.brand} onChange={e=>setC("brand",e.target.value)} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Select label="Platform" value={campForm.platform} onChange={e=>setC("platform",e.target.value)} options={PLATFORMS} />
              <Input label="Payout ($)" type="number" value={campForm.payout_amount} onChange={e=>setC("payout_amount",e.target.value)} placeholder="0.00" />
              <Input label="Deadline" type="date" value={campForm.deadline} onChange={e=>setC("deadline",e.target.value)} />
            </div>
            <Textarea label="Brief" value={campForm.brief} onChange={e=>setC("brief",e.target.value)} rows={3} placeholder="Campaign requirements and creative direction..." />
            <Textarea label="Requirements" value={campForm.requirements} onChange={e=>setC("requirements",e.target.value)} rows={2} placeholder="Hashtags, disclosures, format specs..." />
          </div>
        </Modal>
      )}

      {submitModal && (
        <Modal title="SUBMIT CHARACTER" onClose={()=>setSubmitModal(null)}
          actions={<><button onClick={()=>setSubmitModal(null)} className={css.btnGhost}>Cancel</button><button onClick={submit} className={css.btnVolt}>Submit</button></>}>
          <div className="space-y-3">
            <div className="p-3 bg-[#0d0d12] rounded-lg border border-[#2a2a3a]">
              <div className="text-zinc-100 font-medium">{submitModal.name}</div>
              {submitModal.brand&&<div className="text-zinc-600 text-sm">{submitModal.brand}</div>}
            </div>
            <div>
              <label className={css.label}>Character *</label>
              <select className={css.input} value={subForm.character_id} onChange={e=>setSubForm(p=>({...p,character_id:e.target.value}))}>
                <option value="">Select character</option>
                {characters.map(c=><option key={c.id} value={c.id}>{c.character_id} — {c.name}</option>)}
              </select>
            </div>
            <Input label="Submission URL" value={subForm.submission_url} onChange={e=>setSubForm(p=>({...p,submission_url:e.target.value}))} placeholder="https://instagram.com/p/..." />
            <Input label="Notes" value={subForm.notes} onChange={e=>setSubForm(p=>({...p,notes:e.target.value}))} />
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── ROOT APP ─────────────────────────────────────────────────
const NAV = [
  { id:"dashboard", icon:LayoutDashboard, label:"Dashboard" },
  { id:"characters", icon:Users, label:"Characters" },
  { id:"calendar", icon:CalendarDays, label:"Content Calendar" },
  { id:"campaigns", icon:Megaphone, label:"Campaigns" },
];

export default function App() {
  const [page, setPage] = useState("dashboard");
  const [characters, setCharacters] = useState([]);
  const [content, setContent] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);

  // Fetch all data from API on mount
  useEffect(() => {
    Promise.all([
      api.characters.list().then(data => data.map(normalizeChar)),
      api.content.list().then(data => data.map(normalizeContent)),
      api.campaigns.list().then(data => data.map(normalizeCampaign)),
    ])
      .then(([chars, cont, camps]) => {
        setCharacters(chars);
        setContent(cont);
        setCampaigns(camps);
      })
      .catch(err => console.error("Failed to load data:", err))
      .finally(() => setLoading(false));
  }, []);

  // ─── API-backed mutation wrappers ─────────────────────────
  const apiSetCharacters = useCallback((updater) => {
    // For simple state updates from child components, we intercept
    // and handle API calls in the child components directly.
    // This wrapper is for compatibility with existing component props.
    if (typeof updater === "function") {
      setCharacters(updater);
    } else {
      setCharacters(updater);
    }
  }, []);

  const apiSetContent = useCallback((updater) => {
    if (typeof updater === "function") {
      setContent(updater);
    } else {
      setContent(updater);
    }
  }, []);

  const apiSetCampaigns = useCallback((updater) => {
    if (typeof updater === "function") {
      setCampaigns(updater);
    } else {
      setCampaigns(updater);
    }
  }, []);

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500;600&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; background: #09090f; color: #f4f4f5; font-family: 'DM Sans', sans-serif; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #09090f; }
        ::-webkit-scrollbar-thumb { background: #2a2a3a; border-radius: 2px; }
        ::-webkit-scrollbar-thumb:hover { background: #C8FF00; }
      `}</style>
      <div style={{ display:"flex", height:"100vh", overflow:"hidden", background:"#09090f" }}>
        {/* Sidebar */}
        <aside style={{ width:220, flexShrink:0, borderRight:"1px solid #1e1e2a", background:"#0d0d14", display:"flex", flexDirection:"column" }}>
          <div style={{ padding:"20px", borderBottom:"1px solid #1e1e2a" }}>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <div style={{ width:32, height:32, background:"#C8FF00", borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center" }}>
                <Zap size={15} color="#09090f" strokeWidth={2.5} />
              </div>
              <div>
                <div style={{ fontFamily:"'Bebas Neue', sans-serif", fontSize:16, letterSpacing:"0.1em", lineHeight:1, color:"#f4f4f5" }}>INFLUENCER</div>
                <div style={{ fontFamily:"'Bebas Neue', sans-serif", fontSize:16, letterSpacing:"0.1em", lineHeight:1, color:"#C8FF00" }}>FACTORY</div>
              </div>
            </div>
          </div>
          <nav style={{ flex:1, padding:"12px 10px", display:"flex", flexDirection:"column", gap:2 }}>
            {NAV.map(({id,icon:Icon,label})=>(
              <button key={id} onClick={()=>setPage(id)} style={{
                display:"flex", alignItems:"center", gap:10, padding:"10px 12px", borderRadius:10, border:"none",
                background:page===id?"#C8FF00":"transparent", color:page===id?"#09090f":"#71717a",
                fontFamily:"'DM Sans', sans-serif", fontSize:13, fontWeight:page===id?600:400, cursor:"pointer",
                transition:"all 0.15s"
              }}>
                <Icon size={15} strokeWidth={1.75} />
                {label}
              </button>
            ))}
          </nav>
          <div style={{ padding:"16px 20px", borderTop:"1px solid #1e1e2a" }}>
            <div style={{ fontSize:11, color:"#3f3f50" }}>Powered by Higgsfield AI</div>
            <a href="https://higgsfield.ai" target="_blank" rel="noreferrer" style={{ fontSize:11, color:"#C8FF00", textDecoration:"none" }}>Open Studio →</a>
          </div>
        </aside>

        {/* Main */}
        <main style={{ flex:1, overflowY:"auto" }}>
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <div className="w-8 h-8 border-2 border-[#C8FF00] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
                <p className="text-zinc-500 text-sm">Loading portfolio...</p>
              </div>
            </div>
          ) : (
            <>
              {page==="dashboard" && <Dashboard characters={characters} content={content} campaigns={campaigns} />}
              {page==="characters" && <Characters characters={characters} setCharacters={apiSetCharacters} />}
              {page==="calendar" && <ContentCalendar content={content} setContent={apiSetContent} characters={characters} />}
              {page==="campaigns" && <Campaigns campaigns={campaigns} setCampaigns={apiSetCampaigns} characters={characters} />}
            </>
          )}
        </main>
      </div>
    </>
  );
}
