import json, urllib.request, math, statistics

url=("https://archive-api.open-meteo.com/v1/archive?latitude=15.19&longitude=145.745"
     "&start_date=2015-01-01&end_date=2026-10-18"
     "&daily=precipitation_sum,precipitation_hours,wind_speed_10m_max,wind_gusts_10m_max,temperature_2m_max,surface_pressure_mean"
     "&timezone=Pacific%2FSaipan")
d=json.load(urllib.request.urlopen(url, timeout=60))["daily"]
n=len(d["time"]); P=d["precipitation_sum"]; H=d["precipitation_hours"]; W=d["wind_speed_10m_max"]; S=d["surface_pressure_mean"]
pres=[v for v in S if v is not None]; presMed=statistics.median(pres)
rs=sorted(v for v in P if v is not None)
def q(a,p):
    pos=(len(a)-1)*p; lo=math.floor(pos); hi=math.ceil(pos)
    return a[lo] if lo==hi else a[lo]+(a[hi]-a[lo])*(pos-lo)
tail=q(rs,0.97)
FK=["rain1","rain3","rain7","wetHours","windMax","presAnom","wetSeason"]
rows=[]
g=lambda A,i: (A[i] if i>=0 and A[i] is not None else 0)
for i in range(7,n):
    r1=g(P,i); r3=g(P,i-1)+g(P,i-2)+g(P,i-3); r7=r3+g(P,i-4)+g(P,i-5)+g(P,i-6)+g(P,i-7)
    m=int(d["time"][i][5:7])
    x={"rain1":r1,"rain3":r3,"rain7":r7,"wetHours":g(H,i),"windMax":g(W,i),
       "presAnom":max(0,presMed-(S[i] if S[i] is not None else presMed)),
       "wetSeason":1 if 7<=m<=11 else 0}
    y=1 if (r1>=tail or (r1+g(P,i-1))>=75) else 0
    rows.append((x,y))
cut=int(len(rows)*.8); tr=rows[:cut]; te=rows[cut:]
sc={k:(statistics.fmean([r[0][k] for r in tr]), statistics.pstdev([r[0][k] for r in tr]) or 1) for k in FK}
enc=lambda x:[(x[k]-sc[k][0])/sc[k][1] for k in FK]
Xtr=[enc(r[0]) for r in tr]; ytr=[r[1] for r in tr]
pos=sum(ytr) or 1; neg=len(ytr)-pos or 1
wP=len(ytr)/(2*pos); wN=len(ytr)/(2*neg)
sig=lambda z:1/(1+math.exp(-max(-30,min(30,z))))
w=[0.0]*len(FK); b=0.0; lr=.32; l2=.004
for ep in range(320):
    gw=[0.0]*len(FK); gb=0.0; loss=0.0; ws=0.0
    for xi,yi in zip(Xtr,ytr):
        z=b+sum(w[j]*xi[j] for j in range(len(w))); p=sig(z)
        cw=wP if yi==1 else wN
        loss+=-cw*(yi*math.log(max(p,1e-12))+(1-yi)*math.log(max(1-p,1e-12))); ws+=cw
        gd=cw*(p-yi)
        for j in range(len(w)): gw[j]+=gd*xi[j]
        gb+=gd
    for j in range(len(w)): w[j]-=lr*(gw[j]/ws+l2*w[j])
    b-=lr*gb/ws
    if ep in (0,40,160,319): print(f"  epoch {ep:3d} loss {loss/ws:.4f}")
def ev(rows,name):
    sd=[(sig(b+sum(w[j]*enc(x)[j] for j in range(len(w)))),y) for x,y in rows]
    tp=fp=tn=fn=0; br=0
    for p,y in sd:
        pr=1 if p>=.5 else 0
        if pr and y: tp+=1
        elif pr and not y: fp+=1
        elif not pr and not y: tn+=1
        else: fn+=1
        br+=(p-y)**2
    P_=tp/(tp+fp) if tp+fp else 0; R=tp/(tp+fn) if tp+fn else 0
    ps=[s for s in sd if s[1]==1]; ng=[s for s in sd if s[1]==0]
    srt=sorted(sd,key=lambda s:s[0]); rk=[0]*len(srt); i=0
    while i<len(srt):
        j=i
        while j+1<len(srt) and srt[j+1][0]==srt[i][0]: j+=1
        ar=(i+j)/2+1
        for k in range(i,j+1): rk[k]=ar
        i=j+1
    rsp=sum(rk[k] for k in range(len(srt)) if srt[k][1]==1)
    auc=(rsp-len(ps)*(len(ps)+1)/2)/(len(ps)*len(ng)) if ps and ng else None
    print(f"  {name}: n={len(rows)} acc={(tp+tn)/len(rows):.3f} prec={P_:.3f} rec={R:.3f} "
          f"f1={(2*P_*R/(P_+R) if P_+R else 0):.3f} auc={auc:.3f} brier={br/len(rows):.4f} pos_rate={len(ps)/len(rows):.3f}")
print(f"rows={len(rows)} tail_threshold={tail:.1f}mm positives={sum(y for _,y in rows)} presMedian={presMed:.1f}")
ev(tr,"TRAIN"); ev(te,"TEST ")
print("weights:"); [print(f"  {k:10s} {v:+.3f}") for k,v in zip(FK,w)]
print(f"  bias       {b:+.3f}")
