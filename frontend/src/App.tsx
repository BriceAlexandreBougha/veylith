import { lazy, Suspense, useEffect, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import { CheckCircle2, CircleAlert, Eye, EyeOff, Fingerprint, LoaderCircle, ShieldCheck, Smartphone } from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { supabase, supabaseConfigured } from "./lib/supabase";

const Dashboard = lazy(() => import("./components/Dashboard"));

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [mode, setMode] = useState<
    "login" | "signup" | "reset" | "update-password"
  >("login");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [logoutDialog, setLogoutDialog] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error" | "info"; text: string } | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);

      if (window.location.pathname === "/reset-password") {
        if (data.session) {
          setMode("update-password");
        } else {
          setMessage({
            kind: "error",
            text: "Ce lien de réinitialisation est invalide ou expiré. Demande un nouveau lien.",
          });
        }
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);

      if (event === "PASSWORD_RECOVERY") {
        setMode("update-password");
        setMessage(null);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      if (!supabaseConfigured) throw new Error("Configure VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY dans le fichier .env, puis redémarre Vite.");
      if (mode === "update-password") {
        if (password.length < 8) {
          throw new Error("Le mot de passe doit contenir au moins 8 caractères.");
        }
        if (password !== confirmPassword) {
          throw new Error("Les deux mots de passe ne correspondent pas.");
        }

        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;

        window.history.replaceState({}, document.title, "/");
        setPassword("");
        setConfirmPassword("");
        setMode("login");
        setMessage({
          kind: "ok",
          text: "Mot de passe modifié. Votre session reste active.",
        });
      } else if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email, password,
          options: {
            emailRedirectTo: `${window.location.origin}/`,
            data: { username: username.trim() },
          }
        });
        if (error) throw error;
        if (!data.session) {
          setMessage({ kind: "ok", text: "Compte créé. Vérifie ta boîte mail pour confirmer ton adresse avant de te connecter." });
        } else {
          setMessage({ kind: "ok", text: "Compte créé et connecté." });
        }
      } else if (mode === "reset") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/reset-password`
        });
        if (error) throw error;
        setMessage({ kind: "ok", text: "Si cette adresse est enregistrée, un e-mail de réinitialisation va être envoyé." });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        setMessage({ kind: "ok", text: "Connexion réussie." });
      }
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Une erreur est survenue." });
    } finally {
      setBusy(false);
    }
  }

  async function oauth(provider: "google" | "apple") {
    setBusy(true);
    setMessage(null);
    try {
      if (!supabaseConfigured) throw new Error("Configure d'abord les variables Supabase dans le fichier .env.");
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo: `${window.location.origin}/` }
      });
      if (error) throw error;
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Connexion OAuth impossible." });
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    const { error } = await supabase.auth.signOut();
    setBusy(false);
    setMessage(error ? { kind: "error", text: error.message } : { kind: "ok", text: "Déconnexion effectuée." });
  }

  async function confirmLogout() {
    await logout();
    setLogoutDialog(false);
  }

  const isDashboard = Boolean(session && mode !== "update-password");

  // L’espace connecté est une application séparée de l’écran d’authentification.
  // Une session restaurée ou créée par OAuth arrive donc directement sur l’accueil.
  if (isDashboard && session) {
    return <><Suspense fallback={<main className="dashboard-loading" aria-label="Chargement de votre espace"><LoaderCircle className="spin" size={24}/></main>}><Dashboard session={session} onLogout={() => setLogoutDialog(true)} busy={busy} /></Suspense>{logoutDialog&&<div className="dialog-scrim" role="presentation" onMouseDown={(event)=>{if(event.target===event.currentTarget)setLogoutDialog(false)}}><section className="decision-dialog" role="dialog" aria-modal="true" aria-labelledby="logout-title"><button className="dialog-close" onClick={()=>setLogoutDialog(false)} aria-label="Fermer">×</button><span className="dialog-icon"><ShieldCheck size={21}/></span><span className="card-kicker">SESSION VEYLITH</span><h2 id="logout-title">Se déconnecter ?</h2><p>Votre session prendra fin sur cet appareil. Vous pourrez vous reconnecter à tout moment.</p><div className="dialog-actions"><button className="outline-button" onClick={()=>setLogoutDialog(false)}>Rester connecté</button><button className="danger-button" onClick={()=>void confirmLogout()} disabled={busy}>{busy?<LoaderCircle className="spin" size={16}/>:null}Se déconnecter</button></div></section></div>}</>;
  }

  return (
    <main className="auth-page">
      <section className="auth-showcase">
        <a className="auth-wordmark" href="/">VEYLITH</a>
        <span className="auth-tagline">STRATÉGIE · TERRAIN · EXPLORATION</span>
        <h1>{mode === "reset" || mode === "update-password" ? "Votre route reprend ici." : "Le terrain vous attend."}</h1>
        <p>Retrouvez vos parties, vos amis et vos terrains. Chaque traversée commence par un choix.</p>
        <TerrainArt />
        <div className="auth-showcase-foot"><Fingerprint size={16}/> VOTRE COMPTE · VOTRE PROGRESSION</div>
      </section>
      <section className="auth-main">
        <header className="auth-mobile-brand"><a className="auth-wordmark" href="/">VEYLITH</a><span>STRATÉGIE · TERRAIN · EXPLORATION</span></header>
        <div className="auth-form-panel">
          <span className="card-kicker">{mode === "signup" ? "VOTRE ESPACE DE JEU" : mode === "reset" || mode === "update-password" ? "RÉCUPÉRATION DU COMPTE" : "VOTRE ESPACE DE JEU"}</span>
          <h2>{mode === "signup" ? "Créer un compte" : mode === "reset" ? "Mot de passe oublié ?" : mode === "update-password" ? "Nouveau mot de passe" : "Connexion"}</h2>
          <p className="auth-description">{mode === "signup" ? "Créez votre profil pour commencer à jouer." : mode === "reset" ? "Nous vous enverrons un lien pour choisir un nouveau mot de passe." : mode === "update-password" ? "Choisissez un nouveau mot de passe pour votre compte." : "Connectez-vous pour retrouver votre profil et reprendre la partie."}</p>
          {mode !== "reset" && mode !== "update-password" && <form onSubmit={handleSubmit} className="auth-form">
            <label htmlFor="email">Adresse e-mail</label><input id="email" type="email" autoComplete="email" placeholder="vous@exemple.com" value={email} onChange={e=>{setEmail(e.target.value);if(mode==="signup"&&!username)setUsername(e.target.value.split("@")[0].replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,24))}} required/>
            {mode==="signup"&&<><label htmlFor="username">Nom d’utilisateur</label><input id="username" type="text" autoComplete="username" placeholder="Votre nom de joueur" value={username} onChange={e=>setUsername(e.target.value)} minLength={3} maxLength={24} pattern="[a-zA-Z0-9_-]+" title="3 à 24 caractères : lettres, chiffres, tiret ou tiret bas." required/><small className="auth-hint">3 à 24 caractères : lettres, chiffres, tiret ou tiret bas.</small></>}
            <label htmlFor="password">Mot de passe</label><div className="password-wrap"><input id="password" type={showPassword?"text":"password"} autoComplete={mode==="signup"?"new-password":"current-password"} placeholder="Votre mot de passe" value={password} onChange={e=>setPassword(e.target.value)} minLength={6} required/><button className="reveal" type="button" onClick={()=>setShowPassword(v=>!v)} aria-label={showPassword?"Masquer":"Afficher"}>{showPassword?<EyeOff size={17}/>:<Eye size={17}/>}</button></div>
            {mode==="signup"&&<label className="remember-option"><input type="checkbox" required/>J’accepte de créer un compte VEYLITH</label>}
            {mode==="login"&&<div className="auth-options"><label className="remember-option"><input type="checkbox" checked readOnly/>Rester connecté</label><button type="button" className="link-button" onClick={()=>{setMode("reset");setMessage(null)}}>Mot de passe oublié ?</button></div>}
            <button className="primary-button auth-submit" type="submit" disabled={busy}>{busy?<LoaderCircle className="spin" size={17}/>:null}{mode==="signup"?"Créer mon compte":"Se connecter"}</button>
          </form>}
          {(mode==="reset"||mode==="update-password")&&<form onSubmit={handleSubmit} className="auth-form">
            {mode==="reset"?<><label htmlFor="email">Adresse e-mail</label><input id="email" type="email" autoComplete="email" placeholder="vous@exemple.com" value={email} onChange={e=>setEmail(e.target.value)} required/></>:<><label htmlFor="new-password">Nouveau mot de passe</label><input id="new-password" type="password" autoComplete="new-password" placeholder="8 caractères minimum" value={password} onChange={e=>setPassword(e.target.value)} minLength={8} required/><label htmlFor="confirm-password">Confirmer le mot de passe</label><input id="confirm-password" type="password" autoComplete="new-password" placeholder="Répétez le mot de passe" value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)} minLength={8} required/></>}
            <button className="primary-button auth-submit" type="submit" disabled={busy}>{busy?<LoaderCircle className="spin" size={17}/>:null}{mode==="reset"?"Envoyer le lien":"Enregistrer le nouveau mot de passe"}</button>
          </form>}
          {mode!=="update-password"&&mode!=="reset"&&<><div className="auth-divider"><span/>ou continuer avec<span/></div><div className="oauth-row"><button className="oauth-button" onClick={()=>void oauth("google")} disabled={busy}><span className="google-g">G</span>Google</button><button className="oauth-button" onClick={()=>void oauth("apple")} disabled={busy}><Smartphone size={17}/>Apple</button></div></>}
          <div className="switch-mode">{mode==="reset"||mode==="update-password"?<><button onClick={()=>{setMode("login");setPassword("");setConfirmPassword("")}}>← Retour à la connexion</button></>:mode==="signup"?<>Déjà un compte ? <button onClick={()=>{setMode("login");setMessage(null)}}>Se connecter</button></>:<>Pas encore de compte ? <button onClick={()=>{setMode("signup");setUsername(email.split("@")[0].replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,24));setMessage(null)}}>Créer un compte</button></>}</div>
          {message&&<div className={`message message-${message.kind}`}>{message.kind==="error"?<CircleAlert size={16}/>:<CheckCircle2 size={16}/>}<span>{message.text}</span></div>}
          {!supabaseConfigured&&<div className="config-warning"><CircleAlert size={15}/>Variables Supabase à configurer dans <code>.env</code>.</div>}
        </div>
        <footer className="auth-footer"><span><ShieldCheck size={14}/> Connexion sécurisée</span><span>VEYLITH © 2026</span></footer>
      </section>
    </main>
  );
}

function TerrainArt(){return <div className="auth-terrain" aria-hidden="true"><div className="auth-terrain-orbit"/><div className="auth-terrain-grid">{Array.from({length:36},(_,index)=>{const row=Math.floor(index/6);const col=index%6;const level=Math.max(0,3-Math.floor((Math.abs(row-2.5)+Math.abs(col-2.5))/1.7));return <i key={index} style={{"--x":`${(col-row)*22}px`,"--y":`${(row+col)*11-level*8}px`,"--level":level} as CSSProperties}/>})}</div></div>}
