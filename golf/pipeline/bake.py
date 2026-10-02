import json,numpy as np
from scipy.spatial.transform import Rotation as Rr
from scipy.ndimage import gaussian_filter1d as gf
s=json.load(open('pack/claude-golf-3d-pack/track_faceon_smooth.json'))
mp=json.load(open('mp2d.json'))['frames']
N=840; IDS=[0,7,8,11,12,13,14,15,16,23,24,25,26,27,28,29,30,31,32]
S=np.diag([1.,-1.,-1.])
# --- joints: provided track, z un-mirrored (C-up: x right, y up, z toward camera)
J={i:gf(np.array(s['joints'][str(i)])*[1,1,-1],1.5,axis=0,mode='nearest') for i in IDS}
# --- camera solve (fresh heavy-model run): P_cam = R*W + t
fl=1650.; cx,cy=960.,540.
R=Rr.from_rotvec(np.load('camrot.npy')).as_matrix()
W=np.array([[f['world'][i] for i in IDS] for f in mp]); U=np.array([[f['img'][i][:2] for i in IDS] for f in mp])*[1920,1080]
V=np.array([[f['img'][i][3] for i in IDS] for f in mp])
T=np.zeros((N,3))
for k in range(N):
    w=W[k]@R.T; u=U[k]; vis=np.sqrt(np.clip(V[k],0.05,1)); A=[];b=[];wt=[]
    for j in range(19):
        A+=[[-fl,0,u[j,0]-cx],[0,-fl,u[j,1]-cy]]; b+=[fl*w[j,0]-(u[j,0]-cx)*w[j,2],fl*w[j,1]-(u[j,1]-cy)*w[j,2]]; wt+=[vis[j]]*2
    A=np.array(A)*np.array(wt)[:,None]; b=np.array(b)*np.array(wt); T[k]=np.linalg.lstsq(A,b,rcond=None)[0]
Ts=gf(T,6,axis=0,mode='nearest')
O=(S@R.T@Ts.T).T                      # hip-centre position rel. camera, C-up
root=O-O[0]; root[:,0]*=0.9; root[:,2]=0  # depth-from-scale is noise; drop it. x scaled to provided-track units
root[:,1]=gf(root[:,1],10,mode='nearest')
camPos=-O[0]                          # camera rel. hip centre at f0
camFwd=S@R.T@np.array([0,0,1.]); camUp=S@R.T@np.array([0,-1,0.])
# --- golfer frame: rotate about y so address facing -> +z (target -> +x)
def facing(l,r,fr):
    v=np.mean([J[r][f]-J[l][f] for f in fr],0); f=np.array([v[2],0,-v[0]]); return f/np.linalg.norm(f)
fa=facing(23,24,range(60))+facing(11,12,range(60)); fa/=np.linalg.norm(fa)
beta=np.arctan2(fa[0],fa[2])          # rotate by -beta about y
Ry=Rr.from_euler('y',-beta).as_matrix()
print('address facing yaw (deg):',np.degrees(beta))
G={i:(J[i]@Ry.T) for i in IDS}
root=root@Ry.T; camPos=Ry@camPos; camFwd=Ry@camFwd; camUp=Ry@camUp
hip0=(G[23][0]+G[24][0])/2
# per-frame: add root translation; hip-centre the joints at their own hip mid then place
for i in IDS: G[i]=G[i]+root
# --- club: lead-arm swing angle + hinge model fused with image angle via camera back-projection
a=np.array(s['clubDir'])
X=np.array([1.,0,0])                  # target direction
sm=(G[11]+G[12])/2; grip=(G[15]+G[16])/2
arm=grip-sm; a0=np.mean(arm[:30],0); a0/=np.linalg.norm(a0)
q_ax=-X-np.dot(-X,a0)*a0; q_ax/=np.linalg.norm(q_ax)
P2=np.stack([arm@a0,arm@q_ax],1); P2=gf(P2,2,axis=0,mode='nearest')
phi=np.unwrap(np.arctan2(P2[:,1],P2[:,0]))
TOP,IMP=450,624
ga=gf(arm,2,axis=0,mode='nearest'); cosg=np.clip((ga@a0)/np.linalg.norm(ga,axis=1),-1,1)
post=-np.arccos(cosg); phi[IMP:]=post[IMP:]-post[IMP]+phi[IMP]
phi=gf(phi,3,mode='nearest')
def ss(e0,e1,x): t=np.clip((x-e0)/(e1-e0),0,1); return t*t*(3-2*t)
H=np.zeros(N); Hm=np.radians(85)
pimp=phi[IMP]
for f in range(N):
    p=phi[f]
    if f<=TOP: H[f]=Hm*ss(np.radians(10),np.radians(95),p)
    elif f<=IMP: H[f]=Hm*ss(pimp+np.radians(8),pimp+np.radians(75),p)
    else: H[f]=-Hm*ss(np.radians(20),np.radians(110),pimp-p)
lam=np.array([0 if f<=TOP else (ss(TOP,IMP,f) if f<=IMP else 1.0) for f in range(N)])
H=gf(H,4,mode='nearest'); theta=phi+H-lam*pimp
# shaft dir from model: in swing plane spanned by address shaft d0 and away-from-target axis
d0=np.array([np.cos(a[:20].mean()),-np.sin(a[:20].mean()),0.]); d0=np.array([d0[0],d0[1],0])  # placeholder (camera space), replaced below
# grip image point = mean of hand landmarks 15..22 (both hands)
GI=np.array([[np.mean([f['img'][i][0] for i in range(15,23)])*1920,np.mean([f['img'][i][1] for i in range(15,23)])*1080] for f in mp])
GI=gf(GI,1.5,axis=0,mode='nearest')
# golfer-frame camera basis
cr=np.cross(camFwd,camUp); cr/=np.linalg.norm(cr); cu=np.cross(cr,camFwd)
# address shaft dir in golfer frame from image angle at address assuming in image plane
def img2world_dir(ang):  # direction parallel to image plane
    return np.cos(ang)*cr - np.sin(ang)*cu
D0=img2world_dir(a[:20].mean()); D0-=np.dot(D0,X)*X*0; D0/=np.linalg.norm(D0)
pa=-X-np.dot(-X,D0)*D0; pa/=np.linalg.norm(pa)
dirs=np.zeros((N,3)); dbg=[]
for f in range(N):
    dm=np.cos(theta[f])*D0+np.sin(theta[f])*pa       # model direction
    # back-projection plane of the image shaft line through camera centre and grip ray
    ray=(GI[f,0]-cx)/fl*cr-(GI[f,1]-cy)/fl*cu+camFwd; ray/=np.linalg.norm(ray)
    w=img2world_dir(a[f]); w-=np.dot(w,ray)*ray; w/=np.linalg.norm(w)
    # in-plane directions d(psi)=cos psi*w + sin psi*ray ; pick psi nearest to model dir
    ps=np.radians(np.linspace(-88,88,177)); cand=np.cos(ps)[:,None]*w+np.sin(ps)[:,None]*ray
    di=cand[np.argmax(cand@dm)]
    conf=abs(np.dot(w,dm))   # image is informative when model dir lies near image plane
    d=dm*(1-0.75*conf)+di*0.75*conf; d/=np.linalg.norm(d); dirs[f]=d
dirs=gf(dirs,3,axis=0,mode='nearest'); dirs/=np.linalg.norm(dirs,axis=1)[:,None]
for f in list(range(0,600,50))+list(range(600,840,10)):
    print(f,np.round(P2[f],2),'phi %4.0f H %4.0f theta %4.0f'%(np.degrees(phi[f]),np.degrees(H[f]),np.degrees(theta[f])),'dir',np.round(dirs[f],2),'imgang %.2f'%a[f])
out={'n':N,'fps':30,'t0':8.0,'ids':IDS,
 'joints':{str(i):np.round(G[i],4).tolist() for i in IDS},
 'club':np.round(dirs,4).tolist(),
 'cam':{'pos':np.round(camPos,4).tolist(),'fwd':np.round(camFwd,4).tolist(),'up':np.round(camUp,4).tolist(),'fovY':float(np.degrees(2*np.arctan(540/fl)))},
 'hip0':np.round(hip0,4).tolist()}
json.dump(out,open('baked.json','w'),separators=(',',':'))
print('cam',out['cam'],'hip0',hip0)
