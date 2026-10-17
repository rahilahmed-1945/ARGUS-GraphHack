import math, copy, statistics as st

class Rng:                                   # mulberry32 + Box-Muller (bit-identical to JS mulberry32)
    def __init__(self, seed): self.a = seed & 0xFFFFFFFF
    def u32(self):
        self.a = (self.a + 0x6D2B79F5) & 0xFFFFFFFF; t = self.a
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return (t ^ (t >> 14)) & 0xFFFFFFFF
    def uni(self): return (self.u32() + 0.5) / 4294967296.0
    def gauss(self):
        u1, u2 = self.uni(), self.uni()
        return math.sqrt(-2.0*math.log(u1)) * math.cos(2*math.pi*u2)

def sig(x): return 1.0 if x > 50 else 0.0 if x < -50 else 1/(1+math.exp(-x))
ORDER = ['gateway','mobile-gw','checkout','orders','auth','payments','inventory','ledger-db']

def base_model(kind):                       # == loadModel(graph)
    svc = {'gateway':dict(ext=300,cap=5000,base=20), 'mobile-gw':dict(ext=150,cap=5000,base=20),
           'auth':dict(ext=0,cap=1500,base=30), 'checkout':dict(ext=0,cap=2000,base=40),
           'orders':dict(ext=0,cap=1000,base=40), 'payments':dict(ext=0,cap=800,base=80),
           'inventory':dict(ext=0,cap=4000,base=30), 'ledger-db':dict(ext=0,cap=550,base=20)}
    for n,s in svc.items():
        s['sd'] = 0.0 if kind=='world' else (0.15 if n=='payments' else 0.05)
        s['qmax_s']=2.0; s['surge']=1.0; s['shed']=0.0; s['degrade']=1.0
    if kind=='world': svc['payments']['cap'] = 704
    E = [('gateway','auth',1,1,300),('gateway','checkout',1,2,1000),('mobile-gw','auth',1,1,300),
         ('mobile-gw','orders',1,0,1000),('checkout','payments',1,3,500),('checkout','inventory',1,1,300),
         ('orders','ledger-db',2,0,300),('orders','inventory',1,1,300),('payments','ledger-db',0.2,0,300)]
    edges = {(a,b):dict(fanout=f,retries=r,timeout=t,breaker=False,trip_p=0.5,trip_ticks=5,cooldown=10)
             for a,b,f,r,t in E}
    ces = {'CE-42':dict(edge=('orders','ledger-db'),retries=3,status='pending'),
           'CE-17':dict(edge=('checkout','inventory'),retries=3,status='pending')}
    mag = {'degrade':0.6, 'surge':1.4}                       # Fault.magnitude (per kind on the seed)
    fac = {'scale_out':1.5, 'shed':0.10, 'cap_retries':1}    # Intervention.factor
    rnd = dict(slo_goodput=0.99, slo_latency_ms=800, slo_width_ms=80, arrival_noise=0.05,
               obs_noise=0.05, t_off=30)                     # (:Round) constants
    return dict(svc=svc, edges=edges, ces=ces, mag=mag, fac=fac, rnd=rnd)

def init_state(m):
    return dict(q={n:0.0 for n in m['svc']}, p={e:0.0 for e in m['edges']},
                hot={e:0 for e in m['edges']}, open={e:0 for e in m['edges']})

def set_faults(m, faults, on):              # transient: degrade, surge. persistent: deploy
    for f in faults:
        k, tgt = f.split(':',1)
        if k=='degrade': m['svc'][tgt]['degrade'] = m['mag']['degrade'] if on else 1.0
        elif k=='surge': m['svc'][tgt]['surge'] = m['mag']['surge'] if on else 1.0
        elif k=='deploy' and on:
            ce = m['ces'][tgt]
            if ce['status']=='pending': m['edges'][ce['edge']]['retries']=ce['retries']; ce['status']='landed'

def apply_iv(m, iv):
    k, tgt = iv.split(':',1)
    if k=='retries_off': a,b=tgt.split('>'); m['edges'][(a,b)]['retries']=0
    elif k=='cap_retries': a,b=tgt.split('>'); m['edges'][(a,b)]['retries']=min(m['fac']['cap_retries'],m['edges'][(a,b)]['retries'])
    elif k=='breaker': a,b=tgt.split('>'); m['edges'][(a,b)]['breaker']=True
    elif k=='scale_out': m['svc'][tgt]['cap'] *= m['fac']['scale_out']
    elif k=='shed': m['svc'][tgt]['shed'] = m['fac']['shed']
    elif k=='block_deploy': m['ces'][tgt]['status']='blocked'
    # 'none:x' (do nothing) falls through

def step(m, s_, mu, rng):
    S, E, q, p, R = m['svc'], m['edges'], s_['q'], s_['p'], m['rnd']
    served, dropped, work, arr = {}, {}, {}, {}
    for n in ORDER:                                            # fixed draw order
        arr[n] = S[n]['ext']*S[n]['surge']*(1-S[n]['shed'])*(1+R['arrival_noise']*rng.gauss()) if S[n]['ext'] else 0.0
    for n in ORDER:                                            # forward pass
        for (a,b),e in E.items():
            if b==n:
                if s_['open'][(a,b)]>0: A=0.0
                else: pe=min(p[(a,b)],0.999999); A=(1-pe**(e['retries']+1))/(1-pe)
                arr[n]+=served[a]*e['fanout']*A
        w=q[n]+arr[n]; sv=min(w,mu[n]); qm=S[n]['qmax_s']*mu[n]
        q[n]=min(w-sv,qm); dropped[n]=max(0.0,w-sv-qm); served[n]=sv; work[n]=w
    lat, ok = {}, {}
    for n in reversed(ORDER):                                  # reverse pass
        down=0.0; okp=1.0
        for (a,b),e in E.items():
            if a!=n: continue
            k=(a,b)
            if s_['open'][k]>0:
                pe=1.0; s_['open'][k]-=1
                if s_['open'][k]==0: pe=0.0; s_['hot'][k]=0
                d=0.0
            else:
                pt=sig((lat[b]-e['timeout'])/(0.1*e['timeout']))
                pd=dropped[b]/work[b] if work[b]>0 else 0.0
                pe=1-(1-pt)*(1-pd)*ok[b]; d=min(lat[b],e['timeout'])
                if e['breaker']:
                    s_['hot'][k]= s_['hot'][k]+1 if pe>e['trip_p'] else 0
                    if s_['hot'][k]>=e['trip_ticks']: s_['open'][k]=e['cooldown']; pe=1.0; s_['hot'][k]=0
            p[k]=pe; okp*=(1-pe**(e['retries']+1)); down=max(down,d)
        lat[n]=S[n]['base']+1000*q[n]/mu[n]+down; ok[n]=okp
    gp={n:(1-dropped[n]/work[n] if work[n] else 1)*ok[n]*(1-sig((lat[n]-R['slo_latency_ms'])/R['slo_width_ms']))
        for n in S if S[n]['ext']}
    ve={n:gp[n]<R['slo_goodput'] for n in gp}                 # per-entry violation (harm test)
    return dict(gp=gp, ve=ve, served=dict(served), q=dict(q))

def rollout(m0, state0, faults, t_off, horizon, seed):
    m=copy.deepcopy(m0); s=copy.deepcopy(state0); rng=Rng(seed)
    base_mu={n:max(1.0,m['svc'][n]['cap']+rng.gauss()*m['svc'][n]['sd']*m['svc'][n]['cap']) for n in ORDER}
    set_faults(m, faults, True); trace=[]
    for t in range(horizon):
        if t==t_off: set_faults(m, faults, False)
        mu={n:base_mu[n]*m['svc'][n]['degrade'] for n in m['svc']}
        o=step(m,s,mu,rng); o['viol']=any(o['ve'].values())
        o['deg']={n:m['svc'][n]['degrade'] for n in m['svc']}; trace.append(o)
    return trace, s

def ensemble(m, state0, faults, t_off, horizon, tag, n=16):   # seeds 1000·tag + k
    trs=[rollout(m,state0,faults,t_off,horizon,1000*tag+k)[0] for k in range(n)]
    rec=sum(not any(o['viol'] for o in tr[-10:]) for tr in trs)
    by_entry={e:[sum(o['ve'][e] for o in tr) for tr in trs] for e in trs[0][0]['ve']}  # Future.viol_by_entry
    return rec, st.median([sum(o['viol'] for o in tr) for tr in trs]), trs, by_entry

def harmful(by_entry_iv, by_entry_none):    # §8: worse than do-nothing on ANY entry (medians)
    return any(st.median(by_entry_iv[e]) > st.median(by_entry_none[e]) for e in by_entry_iv)

def calibrate(world_ticks, svc):           # observation noise + calibration (§4)
    rng=Rng(5000+ORDER.index(svc)); xs=[]; obs_noise=0.05   # = (:Round).obs_noise
    for o in world_ticks:
        g=rng.gauss()                       # one draw per tick, used or not
        if o['q'][svc]>1e-6 and o['deg'][svc]==1.0: xs.append(o['served'][svc]*(1+obs_noise*g))
    if len(xs)<10: return None             # not enough clean saturated ticks: leave twin alone
    mean=st.mean(xs); se=st.stdev(xs)/math.sqrt(len(xs))
    return dict(n=len(xs), cap_mean=mean, se=se, cap_sd=max(se,0.03*mean)/mean)
