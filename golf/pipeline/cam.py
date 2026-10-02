import json, numpy as np
d=json.load(open('mp2d.json'))['frames']
IDS=[0,7,8,11,12,13,14,15,16,23,24,25,26,27,28,29,30,31,32]
W=np.array([[f['world'][i] for i in IDS] for f in d])       # (840,19,3) camera-aligned, y down
U=np.array([[f['img'][i][:2] for i in IDS] for f in d])*[1920,1080]
V=np.array([[f['img'][i][3] for i in IDS] for f in d])
cx,cy=960,540
def solve(fl,Wr=W):
    T=np.zeros((840,3)); err=np.zeros(840)
    for k in range(840):
        w=Wr[k]; u=U[k]; vis=np.sqrt(np.clip(V[k],0.05,1))
        A=[];b=[];wt=[]
        for j in range(19):
            A.append([-fl,0,u[j,0]-cx]); b.append(fl*w[j,0]-(u[j,0]-cx)*w[j,2]); wt.append(vis[j])
            A.append([0,-fl,u[j,1]-cy]); b.append(fl*w[j,1]-(u[j,1]-cy)*w[j,2]); wt.append(vis[j])
        A=np.array(A)*np.array(wt)[:,None]; b=np.array(b)*np.array(wt)
        t=np.linalg.lstsq(A,b,rcond=None)[0]; T[k]=t
        P=w+t; pu=cx+fl*P[:,0]/P[:,2]; pv=cy+fl*P[:,1]/P[:,2]
        err[k]=np.sqrt(np.mean((pu-u[:,0])**2+(pv-u[:,1])**2))
    return T,err
for fl in [900,1200,1500,1800,2200,2800,3500]:
    T,e=solve(fl); print(fl, 'rms px %.1f'%e.mean(), 'tz med %.2f'%np.median(T[:,2]), 'tz std %.3f'%T[:,2].std())
from scipy.spatial.transform import Rotation as Rr
from scipy.optimize import minimize
fl=1650
def tot(rv):
    R=Rr.from_rotvec(rv).as_matrix(); Wr=W@R.T
    T,e=solve(fl,Wr[::1]); return e.mean()
# coarse: subsample frames for speed
Wfull,Ufull,Vfull=W,U,V
sel=np.arange(0,840,20); W,U,V=Wfull[sel],Ufull[sel],Vfull[sel]
import functools
def solve_sub(fl,Wr):
    errs=[];Ts=[]
    for k in range(len(Wr)):
        w=Wr[k];u=U[k];vis=np.sqrt(np.clip(V[k],0.05,1))
        A=[];b=[];wt=[]
        for j in range(19):
            A.append([-fl,0,u[j,0]-cx]);b.append(fl*w[j,0]-(u[j,0]-cx)*w[j,2]);wt.append(vis[j])
            A.append([0,-fl,u[j,1]-cy]);b.append(fl*w[j,1]-(u[j,1]-cy)*w[j,2]);wt.append(vis[j])
        A=np.array(A)*np.array(wt)[:,None];b=np.array(b)*np.array(wt)
        t=np.linalg.lstsq(A,b,rcond=None)[0];P=w+t
        pu=cx+fl*P[:,0]/P[:,2];pv=cy+fl*P[:,1]/P[:,2];errs.append(np.sqrt(np.mean((pu-u[:,0])**2+(pv-u[:,1])**2)))
    return np.mean(errs)
f=lambda rv: solve_sub(fl,W@Rr.from_rotvec(rv).as_matrix().T)
print('identity',f(np.zeros(3)))
r=minimize(f,np.zeros(3),method='Nelder-Mead',options={'xatol':1e-3,'fatol':0.01,'maxiter':400})
print(r.x, r.fun, np.degrees(Rr.from_rotvec(r.x).as_euler('xyz')))
np.save('camrot.npy',r.x)
