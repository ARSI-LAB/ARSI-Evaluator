# Generate with pinned Harbor 527d50deb63a5d279e8c20593c18a2cbc7f61f9e.
import json,logging
from types import SimpleNamespace as N
from harbor.trial.multi_step import MultiStepTrial
from harbor.models.task.config import MultiStepRewardStrategy
from harbor.models.verifier.result import VerifierResult
cases=[
 {'name':'below-threshold','strategy':'mean','rewards':[{'reward':0.5}],'threshold':0.6},
 {'name':'equal-threshold','strategy':'mean','rewards':[{'reward':0.6}],'threshold':0.6},
 {'name':'mean-missing-dimension','strategy':'mean','rewards':[{'reward':0.8,'partial':1},{'reward':1}],'threshold':None},
 {'name':'solver-timeout-with-reward','strategy':'mean','rewards':[{'reward':0.8}],'threshold':0.6,'error':True},
 {'name':'verifier-failure-mean','strategy':'mean','rewards':[{'reward':0.8},None],'threshold':None,'error':True},
 {'name':'verifier-failure-final','strategy':'final','rewards':[{'reward':0.8},None],'threshold':None,'error':True},
 {'name':'missing-gated-dimension','strategy':'mean','rewards':[{'reward':1}],'threshold':{'partial':0.2}},
]
for case in cases:
    trial=object.__new__(MultiStepTrial)
    trial.logger=logging.getLogger('reference')
    trial.config=N(verifier=N(disable=False))
    trial.task=N(config=N(multi_step_reward_strategy=MultiStepRewardStrategy(case['strategy'])))
    results=[N(verifier_result=None if r is None else VerifierResult(rewards=r),exception_info=None) for r in case['rewards']]
    if case.get('error'): results[-1].exception_info=N(exception_type='fixture')
    trial._result=N(step_results=results)
    selected=trial._select_multi_step_reward()
    case['expected']={'continue':not trial._should_stop_after_step(N(name='last',min_reward=case['threshold']),results[-1]),'rewards':None if selected is None else selected.rewards}
print(json.dumps({'harborCommit':'527d50deb63a5d279e8c20593c18a2cbc7f61f9e','cases':cases},indent=2))
