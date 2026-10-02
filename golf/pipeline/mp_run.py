import cv2, json, mediapipe as mp, sys
from mediapipe.tasks import python as mpt
from mediapipe.tasks.python import vision
opts=vision.PoseLandmarkerOptions(base_options=mpt.BaseOptions(model_asset_path='pose_landmarker_heavy.task'),
  running_mode=vision.RunningMode.VIDEO, num_poses=1, min_pose_detection_confidence=0.3, min_tracking_confidence=0.3)
lm=vision.PoseLandmarker.create_from_options(opts)
cap=cv2.VideoCapture('pack/claude-golf-3d-pack/dan_faceon.mov')
fps=30.0; out=[]
idx=0
while True:
    ok,fr=cap.read()
    if not ok: break
    t=idx/fps
    if 8.0-1e-6<=t<36.0-1e-6:
        img=mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(fr,cv2.COLOR_BGR2RGB))
        r=lm.detect_for_video(img,int(t*1000))
        if r.pose_landmarks:
            out.append({'img':[[p.x,p.y,p.z,p.visibility] for p in r.pose_landmarks[0]],'world':[[p.x,p.y,p.z] for p in r.pose_world_landmarks[0]]})
        else: out.append(None)
    idx+=1
json.dump({'w':fr.shape[1] if False else 1920,'h':1080,'frames':out},open('mp2d.json','w'))
print(len(out), sum(o is None for o in out))
