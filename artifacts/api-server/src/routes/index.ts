import { Router, type IRouter } from "express";
import memoriesRouter from "./memories";
import openaiRouter from "./openai";
import adminRouter from "./admin";
import googleRouter from "./google";

const router: IRouter = Router();

router.use(memoriesRouter);
router.use(openaiRouter);
router.use(adminRouter);
router.use(googleRouter);

export default router;
