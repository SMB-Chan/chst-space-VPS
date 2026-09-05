import { Router, type IRouter } from "express";
import memoriesRouter from "./memories";
import openaiRouter from "./openai";

const router: IRouter = Router();

router.use(memoriesRouter);
router.use(openaiRouter);

export default router;
