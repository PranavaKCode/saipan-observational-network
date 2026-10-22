import json, urllib.request, math, statistics
url=("https://archive-api.open-meteo.com/v1/archive?latitude=15.19&longitude=145.745"
     "&start_date=2015-01-01&end_date=2026-10-18"
     "&daily=precipitation_sum,precipitation_hours,wind_speed_10m_max,surface_pressure_mean"
     "&timezone=Pacific%2FSaipan")
d=json.load(urllib.request.urlopen(url, timeout=60))["daily"]
n=len(d["time"]); P=d["precipitation_sum"]; H=d["precipitation_hours"]; W=d["wind_speed_10m_max"]; S=d["surface_pressure_mean"]
presMed=statistics.median([v for v in S if v is not None])
rs=sorted(v for v in P if v is not None)
def q(a,p):
    pos=(len(a)-1)*p; lo=math.floor(pos); hi=math.ceil(pos)
    return a[lo] if lo==hi else a[lo]+(a[hi]-a[lo])*(pos-lo)
tail=q(rs,0.97)
g=lambda A,i:(A[i] if 0<=i<len(A) and A[i] is not None else 0)
# FORECAST HEAD: label = tomorrow is high-impact; features use ONLY today and before
FK=["rain1","rain3","rain7","wetHours","windMax","presAnom","presTrend","wetSeason"]
rows=[]
for i in range(7,n-1):
    r1=g(P,i); r3=g(P,i-1)+g(P,i-2)+g(P,i-3); r7=r3+sum(g(P,i-k) for k in range(4,8))
    m=int(d["time"][i][5:7])
    x={"rain1":r1,"rain3":r3,"rain7":r7,"wetHours":g(H,i),"windMax":g(W,i),
       "presAnom":max(0,presMed-(S[i] if S[i] is not None else presMed)),
       "presTrend":(S[i] if S[i] is not None else presMed)-(S[i-1] if S[i-1] is not None else presMed),
       "wetSeason":1 if 7<=m<=11 else 0}
    tom=g(P,i+1)
    y=1 if (tom>=tail or (tom+r1)>=75) else 0
    rows.append((x,y))
cut=int(len(rows)*.8); tr=rows[:cut]; te=rows[cut:]
sc={k:(statistics.fmean([r[0][k] for r in tr]), statistics.pstdev([r[0][k] for r in tr]) or 1) for k in FK}
enc=lambda x:[(x[k]-sc[k][0])/sc[k][1] for k in FK]
Xtr=[enc(r[0]) for r in tr]; ytr=[r[1] for r in tr]
pos=sum(ytr) or 1; neg=len(ytr)-pos or 1; wP=len(ytr)/(2*pos); wN=len(ytr)/(2*neg)
sig=lambda z:1/(1+math.exp(-max(-30,min(30,z))))
w=[0.0]*len(FK); b=0.0
for ep in range(400):
    gw=[0.0]*len(FK); gb=0.0; ws=0.0
    for xi,yi in zip(Xtr,ytr):
        p=sig(b+sum(w[j]*xi[j] for j in range(len(w)))); cw=wP if yi==1 else wN
        gd=cw*(p-yi); ws+=cw
        for j in range(len(w)): gw[j]+=gd*xi[j]
        gb+=gd
    for j in range(len(w)): w[j]-=.32*(gw[j]/ws+.004*w[j])
    b-=.32*gb/ws
def ev(rows,name):
    sd=[(sig(b+sum(w[j]*enc(x)[j] for j in range(len(w)))),y) for x,y in rows]
    tp=fp=tn=fn=0
    for p,y in sd:
        pr=1 if p>=.5 else 0
        tp+=pr and y; fp+=pr and not y; tn+=(not pr) and (not y); fn+=(not pr) and y
    Pr=tp/(tp+fp) if tp+fp else 0; R=tp/(tp+fn) if tp+fn else 0
    ps=[s for s in sd if s[1]==1]; ng=[s for s in sd if s[1]==0]
    srt=sorted(sd,key=lambda s:s[0]); rk=[0]*len(srt); i=0
    while i<len(srt):
        j=i
        while j+1<len(srt) and srt[j+1][0]==srt[i][0]: j+=1
        for k in range(i,j+1): rk[k]=(i+j)/2+1
        i=j+1
    rsp=sum(rk[k] for k in range(len(srt)) if srt[k][1]==1)
    auc=(rsp-len(ps)*(len(ps)+1)/2)/(len(ps)*len(ng))
    # skill vs climatology baseline (always predict base rate)
    base=len(ps)/len(rows)
    bs=sum((p-y)**2 for p,y in sd)/len(sd); bsref=sum((base-y)**2 for _,y in sd)/len(sd)
    print(f"  {name}: n={len(rows)} acc={(tp+tn)/len(rows):.3f} prec={Pr:.3f} rec={R:.3f} auc={auc:.3f} "
          f"BrierSkill_vs_climo={1-bs/bsref:+.3f}")
print(f"FORECAST HEAD (predict tomorrow, no leakage): rows={len(rows)} positives={sum(y for _,y in rows)}")
ev(tr,"TRAIN"); ev(te,"TEST ")
print("weights:"); [print(f"  {k:10s} {v:+.3f}") for k,v in zip(FK,w)]

# Prior correction: undo class-weight inflation with a logit shift
shift=math.log(wP/wN)
def ev2(rows,name):
    sd=[(sig(b-shift+sum(w[j]*enc(x)[j] for j in range(len(w)))),y) for x,y in rows]
    ps=[s for s in sd if s[1]==1]; base=len(ps)/len(rows)
    bs=sum((p-y)**2 for p,y in sd)/len(sd); bsref=sum((base-y)**2 for _,y in sd)/len(sd)
    mean_p=sum(p for p,_ in sd)/len(sd)
    print(f"  {name}: BrierSkill_vs_climo={1-bs/bsref:+.3f} mean_pred={mean_p:.3f} base_rate={base:.3f}")
print(f"AFTER PRIOR CORRECTION (logit shift {-shift:+.3f}):")
ev2(tr,"TRAIN"); ev2(te,"TEST ")
